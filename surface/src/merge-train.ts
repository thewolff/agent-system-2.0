// The merge-train workload kind (PLAN wl-mv8s8srodefytc rev 17.1 § 1, part 1): Jo's `train <N> [<N> …]` opens a
// workload that takes green PRs one at a time, merges main in without rebasing, lets the resolver
// (surface/scripts/merge-train.ts) fix the conflicts it knows, runs the full suite, then merges a normal-stakes PR
// itself and asks Jo about a production-stakes one, unless Jo's ruling train-signoff decides that question (his train word
// is the sign-off, PLAN wl-mvg8itbt0rz3ls D1-D3: `trainSignoff`), when it merges it as a normal one; a PR it cannot land
// goes back to its owner as a task (part 2).
// This module holds the procedure text the lane reads as its brief (`trainBrief`), a PR's stakes (`prStakes`, D1; it
// reads the ledger and the `repo:` checkout's origin), the check on main's protection (`mainProtectionGap`, D2), the
// bodies of Jo's instruction and the surface's `train:` entry, the train's PR order (`trainPrs`), the slice id rule
// (`sl-train-<k>-<n>`, `sl-train-<k>-<n>-full-<r>`, where
// `<k>` is the train's workload id without its `wl-`), the stop hold the test runner's starter applies (`trainHold`)
// and the skip the close check honours (`trainSkippedOf`). The word itself is parsed and applied in
// surface/src/input.ts; the starter evaluates the hold in surface/scripts/test-runner.ts `cmdStart`.
// Part 2 (rev 17.1 D6-D8): `lane_train_return` records a `train-task:` (`recordTrainTask`), the owner is told
// (`ownerTasks`, read by the lane's aside and its first prompt), the tick settles each task once (`settleTasks`),
// delivers it (`ownerDeliveries`), opens at most one fix workload per (repo, PR) for owner none (`openTrainFix`),
// and wakes a train only when it is `actionable`; `trainTaskWindows` feeds surface/src/errors.ts `trainRouted`.
// Auto-boarding (PLAN wl-mvbjiettjrfpxc D1-D3, D5): a train's members are Jo's `train:` bindings and the tick's `train-board:`
// rows (`trainMembers`); `landingReady` is the ledger half of "a lane finished green", `boardLanding` puts a ready PR on its
// repository's newest open train (pending when held or done, opening one only when none exists), and `trainBrief` reads its members from `merge-train.ts list`.
// Part 4 (PLAN wl-mvbjiettjrfpxc D1, D6, D7): the train tick's boarding scan (`autoboardCandidates`, `boardedWorkloads`,
// `boardSkips`), main's protection read live (`protectionGap`) with its episodes, and the main-red notices, on the standing workload.
import { basename, dirname } from "node:path";
import { parseHandSpawn } from "../../classifier/src/lab";
import { parseReviewGroup, parseReviewLoopEnd, parseReviewRound } from "../../classifier/src/rounds";
import {
	attempts, type ControlEntry, controlEntries, doneBecause, doneBody, heldLive, holdersOf, JO_HOLDER, laneExit, landFirstHeld, landFirstOn, launchRequestedBody, type OwnerTrainTask, PLAN_AUTO_STARTED, parseTrainBoard,
	parseTrainFix, planFirst, planSlice, prBindingInstructionBody, prBindings, sameRepo, supersededBy, type TrainBinding, trainBindings, trainBoardBody, type TrainFix, trainFixBody,
} from "./launch";
import { CLASSIFIER_BY, type EntryRow, type InstructionRow, type Ledger, type MessageRow, newId, type QuestionRow, type SliceRow, type Stakes, type WorkloadStatusRow } from "../../ledger/src/index";
import { askJo, raisedId, type TrainSignoffFact } from "../../gates/src/rulings";
import { canonicalPath } from "../../ledger/src/locality";
import { mainResults, mainVerdicts } from "./main-state";
import { DEFAULT_BRANCH } from "./merge-train-stack";
import { NOTICE_PREFIX } from "./notice";
import {
	type CompareResult, decisionLogFault, isFullSuiteGreen, ownerRepoOf, pushDestBody, type RangeCommit, type RunRecord, SETTLING_VERDICTS, SHA_RE, type TestRunnerConfig, testRuns,
} from "./test-run";
import {
	ESCALATION_BY, HOLD_HOURS, LANE_FULL_TEST_TOOL, LANE_RECORD_ENTRY_TOOL, LANE_TRAIN_RETURN_TOOL, MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY, TRAIN_TASK_FAILED_PREFIX,
} from "./types";

/**
 * The commit status the test runner posts on exactly a run's sha in the PR's repo (PLAN wl-mv8s8srodefytc rev 17.1 D2), for
 * every PR: branch protection on main requires it, so no merge, the train's or Jo's, lands a head without a green from the runner.
 */
export const FULL_SUITE_STATUS = "as2/full-suite";

/** The `done:` line of every merge train (§ 1): what is true when the train is over. */
export const TRAIN_DONE =
	"Every PR on this merge train is terminal (merged by the train or by Jo, skipped because it was merged or closed, or cancelled by Jo's skip) with no train slice left open, and done-because lists each PR's outcome.";

/** The full-suite failures Jo named as known flakes (§ 0): a run whose every failure is one of these is rerun once. */
export const KNOWN_FLAKES: readonly string[] = [
	"surface/test/lane-model-script.test.ts T2p",
	"surface/test/lane-model-script.test.ts T8a-p",
	"surface/test/lane-model-script.test.ts T8b-p",
];

/**
 * The resolver the procedure runs (§ 3): `order`, `resolve`, `convert`, `check`; exit 0 ok, 3 a conflict outside its set, 4 it
 * cannot fix without losing an edit, 2 usage or a git process failure. The train's own copy, by its lane worktree's path: an
 * older PR branch may lack the script, and the script reads the repo from its cwd (the PR worktree).
 */
export const RESOLVE_COMMAND = "bun <your lane worktree>/surface/scripts/merge-train.ts";

/**
 * Step 2's preparation (P-11 row 8 pushes only from a branch, never a detached HEAD): a new local branch at the PR's current
 * head, tracking it, in a new worktree; `<a>` counts attempts at PR `<n>` from 1, since an older attempt's branch stays (row 6
 * holds branch deletion). `<k>` is the train's workload id without `wl-`.
 */
export const TRAIN_PREPARE = "git worktree add --track -b train/<k>-<n>-<a> <a new path beside the lane worktree> origin/<head branch>";

/** Step 6's push from the PR worktree, in a bash call of its own (row 8): that branch's commit onto the PR's head branch. */
export const TRAIN_PUSH = "git push origin HEAD:<head branch>";

/** A train slice id: `sl-train-<k>-<n>` or `sl-train-<k>-<n>-full-<r>`; group 1 is `<k>` (the train's workload id without `wl-`), group 2 the PR number. */
export const TRAIN_SLICE_RE = /^sl-train-([a-z0-9]+)-([1-9]\d*)(?:-full-[1-9]\d*)?$/;

/** PR `n`'s disposition slice on train `wl`: `sl-train-<k>-<n>`. */
export function trainSliceId(wl: string, n: number): string {
	return `sl-train-${wl.replace(/^wl-/, "")}-${n}`;
}

/** PR `n`'s `r`th full-suite slice on train `wl`: `sl-train-<k>-<n>-full-<r>`. */
export function trainFullSliceId(wl: string, n: number, r: number): string {
	return `${trainSliceId(wl, n)}-full-${r}`;
}

/** The PR a train slice of `wl` is for, or null: a slice of another train, or no train slice at all, is never this train's. */
export function trainSlicePr(sliceId: string, wl: string): number | null {
	const m = TRAIN_SLICE_RE.exec(sliceId);
	return m && `wl-${m[1]}` === wl ? Number(m[2]) : null;
}

/** Jo's words for `train`, opening or adding to train `wl`: the instruction body `train:` names. */
export function trainInstructionBody(wl: string, prs: readonly number[]): string {
	return prBindingInstructionBody("train", wl, prs);
}

/** `train: <N> [<N> …] <instruction id>`: the surface's record on the train, written after Jo's instruction in one transaction. */
export function trainBody(prs: readonly number[], instructionId: string): string {
	return `train: ${prs.join(" ")} ${instructionId}`;
}

/** One PR on a train (PLAN wl-mvbjiettjrfpxc D2): its first membership entry, Jo's `train:` (`by` his instruction) or the tick's `train-board:` (`by` that entry). */
export interface TrainMember {
	pr: number;
	source: TrainBinding["source"];
	by: string;
	entryId: string;
	createdAt: string;
}

/**
 * The train's members, in entry order (D2): every valid `train:` binding (Jo's word, `prBindings`, each in Jo's order) and every
 * valid `train-board:` the train tick wrote (`trainBindings`); a PR named twice keeps its first entry. Empty on a workload
 * that is no merge train.
 */
export function trainMembers(entries: readonly EntryRow[], instructions: readonly InstructionRow[]): TrainMember[] {
	const out: TrainMember[] = [];
	for (const b of trainBindings(entries, instructions)) {
		for (const pr of b.prs) if (!out.some((m) => m.pr === pr)) out.push({ pr, source: b.source, by: b.by, entryId: b.entryId, createdAt: b.createdAt });
	}
	return out;
}

/** The train's PRs in membership order (`trainMembers`); empty on a workload that is no merge train. */
export function trainPrs(entries: readonly EntryRow[], instructions: readonly InstructionRow[]): number[] {
	return trainMembers(entries, instructions).map((m) => m.pr);
}

/** Jo's answer resolving `q` with `word`: an `answer` instruction by author jo written by the surface, the question's resolver; else null. */
function joAnswer(q: QuestionRow, instructions: readonly InstructionRow[], word: string): InstructionRow | null {
	if (q.state !== "answered" || q.resolved_by === null) return null;
	const ins = instructions.find((i) => i.id === q.resolved_by);
	if (!ins || ins.kind !== "answer" || ins.question_id !== q.id || ins.author !== "jo" || ins.created_by !== SURFACE_BY) return null;
	return ins.body.trim().toLowerCase() === word ? ins : null;
}

/** A train workload's rows, as one transaction reads them. */
export interface TrainRows {
	entries: readonly EntryRow[];
	instructions: readonly InstructionRow[];
	questions: readonly QuestionRow[];
}

/**
 * Why the test runner refuses `lane_full_test` on this workload now (§ 1 D4, the train's stop hold), or null.
 * A workload with no member (`trainMembers`: Jo's `train:` or the tick's `train-board:`) is never held, so Jo's stop holds a
 * board-only train too (PLAN wl-mvbjiettjrfpxc D2). On a train, a question on any of its train slices answered
 * `stop` by Jo holds every PR unless the newest `train:` entry's instruction comes after that answer in
 * `rows.instructions`, the ledger's order (created_at, then rowid), so Jo's train word in the same millisecond as the
 * stop still resumes it; Jo's train word is the only resume (a board never resumes), so later answers on other questions do not clear it; the
 * newest stop, in the same order, is the one named. An open question holds nothing: the train goes on to the next PR
 * while a production PR's question is open. A slice of another train (`trainSlicePr`) never holds this one. Pass the
 * rows read in the starter's reservation transaction, so a stop answered between admission and reservation still holds.
 */
export function trainHold(rows: TrainRows): string | null {
	if (trainMembers(rows.entries, rows.instructions).length === 0) return null;
	const newest = Math.max(-1, ...prBindings(rows.entries, rows.instructions, ["train"]).map((b) => rows.instructions.findIndex((i) => i.id === b.instructionId)));
	let stop: { q: QuestionRow; n: number; at: number } | null = null;
	for (const q of rows.questions) {
		const n = trainSlicePr(q.slice_id, q.workload_id);
		const ins = n === null ? null : joAnswer(q, rows.instructions, "stop");
		if (n === null || ins === null) continue;
		const at = rows.instructions.indexOf(ins);
		if (at < newest) continue;
		if (stop === null || at > stop.at) stop = { q, n, at };
	}
	return stop === null ? null : `merge train stopped by Jo at #${stop.n} (${stop.q.id}); \`train ${stop.q.workload_id} <N…>\` resumes it`;
}

/** `gh pr view <n> --json number,headRefName,isCrossRepository,headRepository,headRepositoryOwner`, the fields `prStakes` reads. */
export interface StakesView {
	number: number;
	headRefName: string;
	isCrossRepository: boolean;
	headRepository: { name: string } | null;
	headRepositoryOwner: { login: string } | null;
}

/**
 * A PR's stakes on a merge train (D1): `normal` merges itself, `production` asks Jo, `hold` neither merges nor asks until
 * `until` (an ISO time, or `jo` for no end while Jo has not acted; PLAN wl-mvfkv7llkp7nk0 § 3); `reason` says why.
 */
export type PrStakes = { stakes: "normal" | "production"; reason: string } | { stakes: "hold"; reason: string; until: string };

/** The resolver's `stakes` line for `s`: `normal`, `production: <reason>` or `hold: <reason> until <time|jo>`. */
export function prStakesLine(s: PrStakes): string {
	return s.stakes === "normal" ? "normal" : s.stakes === "production" ? `production: ${s.reason}` : `hold: ${s.reason} until ${s.until}`;
}

/** A same-repo workload branch: `wl/<workload id>`; group 1 is the id. */
const WORKLOAD_BRANCH_RE = /^wl\/(wl-[a-z0-9]+)$/;

/** The GitHub `owner/repo` of a checkout's origin (`git -C <path> config --get remote.origin.url`, then `ownerRepoOf`), or null. */
export function checkoutOwnerRepo(path: string): string | null {
	const r = Bun.spawnSync(["git", "-C", path, "config", "--get", "remote.origin.url"], { stdout: "pipe", stderr: "pipe" });
	const url = r.stdout.toString().trim();
	return r.exitCode === 0 && url ? ownerRepoOf(url) : null;
}

/** D1's lookup: the ledger workload a same-repo `wl/<id>` head branch names, on the train's repository; or why there is none. */
type BranchWorkload = { ok: true; id: string; w: WorkloadStatusRow } | { ok: false; reason: string };

function branchWorkload(view: StakesView, trainRepo: string, ledger: Pick<Ledger, "workload" | "entries">): BranchWorkload {
	const no = (reason: string): BranchWorkload => ({ ok: false, reason });
	const want = trainRepo.toLowerCase();
	const n = `#${view.number}`;
	if (view.isCrossRepository) return no(`${n} comes from a fork`);
	const head = view.headRepository && view.headRepositoryOwner ? `${view.headRepositoryOwner.login}/${view.headRepository.name}` : null;
	if (head?.toLowerCase() !== want) return no(`${n}'s head repository ${head ?? "is unknown"}${head ? " is not" : ", not"} the train's ${trainRepo}`);
	const id = WORKLOAD_BRANCH_RE.exec(view.headRefName)?.[1];
	if (id === undefined) return no(`${n}'s head branch ${view.headRefName} is not wl/<workload id>`);
	const w = ledger.workload(id);
	if (!w) return no(`${n}'s branch names ${id}, which is no workload in the ledger`);
	const path = controlEntries(ledger.entries(id)).filter((c) => c.prefix === "repo").at(-1)?.rest ?? null;
	if (path === null) return no(`${id} has no repo: entry`);
	const origin = checkoutOwnerRepo(path);
	if (origin?.toLowerCase() !== want) return no(`${id} is on ${path}, whose origin is ${origin ?? "no GitHub repository"}, not ${trainRepo}`);
	return { ok: true, id, w };
}

/**
 * PR `view`'s stakes on the train whose repository is `trainRepo` (`owner/repo`; D1). Production unless all hold: the PR
 * is no fork (`isCrossRepository` false), its head repository is `trainRepo`, its head branch is `wl/<id>`, `<id>` is a
 * ledger workload whose `repo:` entry (the surface's, read as `controlEntries` reads it) is a checkout whose origin is
 * `trainRepo`, and that workload's stakes are normal. `owner/repo` compares without case, as GitHub does (`servedRepo`).
 * Such a PR is then held (PLAN wl-mvfkv7llkp7nk0 § 3) while its workload's newest valid `plan:` entry is Jo's `halted`
 * (until `jo`, no end), or the auto-start's `approved auto` (`planHold`), and normal otherwise.
 */
export function prStakes(view: StakesView, trainRepo: string, ledger: Ledger): PrStakes {
	const b = branchWorkload(view, trainRepo, ledger);
	if (!b.ok) return { stakes: "production", reason: b.reason };
	if (b.w.stakes !== "normal") return { stakes: "production", reason: `${b.id}'s stakes are ${b.w.stakes}` };
	const hold = planHold(ledger, b.id);
	if (hold !== null) return { stakes: "hold", ...hold };
	return { stakes: "normal", reason: `${b.id} on ${trainRepo}, stakes normal` };
}

/**
 * The hold on workload `id`'s PRs, or null. `plan: halted` holds with no end. `plan: approved auto` holds until HOLD_HOURS after
 * Jo's first typed message following the delivery of the auto-start's notice (the first ESCALATION_BY `notice: PLAN_AUTO_STARTED…`
 * message written at or after that entry): the first row `joInputRow` (surface/extensions/surface-input.ts) writes, an
 * `instruction` on the standing workload by `jo` on the `surface` channel written by SURFACE_BY, created after the notice's
 * `delivered` time (its `changed_at`: the surface only ever moves an orchestrator-bound message held → delivered). The mirrors
 * `orchestrator_record_instruction` writes go on other workloads, so they never count. With the notice still held, or no such
 * row yet, it holds until `jo`; once the time has passed, nothing holds. Jo's `plan: approved <instruction>` holds nothing.
 */
function planHold(ledger: Ledger, id: string): { reason: string; until: string } | null {
	const plan = controlEntries(ledger.entries(id)).filter((c) => c.prefix === "plan").at(-1);
	if (plan === undefined) return null;
	if (/^halted\b/.test(plan.rest)) return { reason: `${id} is halted by Jo (plan: ${plan.rest})`, until: "jo" };
	if (!/^approved auto\b/.test(plan.rest)) return null;
	const started = `${id}'s plan started without Jo's approve (plan: ${plan.rest})`;
	const notice = ledger.db
		.query<MessageRow, [string, string, string, string]>(
			"SELECT * FROM messages WHERE workload_id = ?1 AND created_by = ?2 AND substr(body, 1, length(?3)) = ?3 AND created_at >= ?4 ORDER BY created_at, rowid LIMIT 1",
		)
		.get(id, ESCALATION_BY, `${NOTICE_PREFIX} ${PLAN_AUTO_STARTED}`, plan.createdAt);
	if (notice === null || notice.state === "held") return { reason: `${started}; its notice is not delivered yet`, until: "jo" };
	const typed = ledger
		.instructions(STANDING_WORKLOAD_ID)
		.filter((i) => i.kind === "instruction" && i.author === JO_HOLDER && i.channel === "surface" && i.created_by === SURFACE_BY && i.created_at > notice.changed_at)
		.reduce<InstructionRow | null>((first, i) => (first === null || i.created_at < first.created_at ? i : first), null);
	if (typed === null) return { reason: `${started}; no message from Jo since its notice ${notice.id} was delivered`, until: "jo" };
	const until = new Date(Date.parse(typed.created_at) + HOLD_HOURS * 3_600_000).toISOString();
	if (Date.parse(ledger.now()) >= Date.parse(until)) return null;
	return { reason: `${started}; ${HOLD_HOURS} h after Jo's message ${typed.id}`, until };
}

/**
 * The owner of a train task (D6): the workload D1's lookup finds (`branchWorkload`, the rule `prStakes` reads) when it is
 * still open; null (`owner none`) when the branch is no same-repo `wl/…` on the train's repository, or its workload is
 * missing or closed.
 */
export function taskOwner(view: StakesView, trainRepo: string, ledger: Pick<Ledger, "workload" | "entries">): string | null {
	const b = branchWorkload(view, trainRepo, ledger);
	return b.ok && b.w.status === "open" ? b.id : null;
}

/** Main's protection as read live (D2; PLAN wl-mvbjiettjrfpxc D6): `ok`, a `gap` the rules read names, or `unknown` when a read failed. */
export type Protection = { state: "ok" } | { state: "gap" | "unknown"; text: string };

/** The values GitHub documents for a ruleset's `current_user_can_bypass` (repos/rules, "Get a repository ruleset"). */
const BYPASS_MODES: Record<string, true> = { always: true, pull_requests_only: true, never: true, exempt: true };

/**
 * Main's protection (D2) from its active rules (`gh api repos/<owner/repo>/rules/branches/main`, GitHub's "Get rules for a
 * branch", which needs only metadata read): `ok` when one `required_status_checks` rule names FULL_SUITE_STATUS with no
 * `integration_id` (the runner posts as no particular app), is strict (`strict_required_status_checks_policy`: the branch must
 * be up to date), and sits in a ruleset the merging account cannot bypass: `readRuleset(<the rule's ruleset_id>)` (`gh api
 * repos/<owner/repo>/rulesets/<id>`, run as the gh identity that merges) answers `current_user_can_bypass: "never"`. A missing
 * rule, a non-strict or integration-bound one, or a ruleset the account can bypass is a `gap` naming it; a read that throws,
 * a rules answer that is not a list, or a ruleset answer with no `current_user_can_bypass` GitHub documents (`always`,
 * `pull_requests_only`, `never`, `exempt`: null, `{message: "Not Found"}`, a wrong type) is `unknown` (PLAN wl-mvbjiettjrfpxc
 * D6: a failed read is never a gap; review wl-mvbjiettjrfpxc r1 #3), unless another ruleset already answers `never`.
 * Classic branch protection is not read: its `strict` needs administration read, which the
 * lanes' credentials lack, and "Get a branch" leaves it out. Without such a rule a self-merge could land a head tested on an old main.
 */
export function mainProtectionGap(rules: unknown, readRuleset: (id: number) => unknown): Protection {
	const gap = (text: string): Protection => ({ state: "gap", text });
	if (!Array.isArray(rules)) return { state: "unknown", text: "the rules read is not a list" };
	type Check = { type?: unknown; ruleset_id?: unknown; parameters?: { required_status_checks?: unknown; strict_required_status_checks_policy?: unknown } };
	type Required = { context?: unknown; integration_id?: unknown } | null | undefined;
	const checks = (rules as Check[]).filter((r) => r?.type === "required_status_checks");
	if (checks.length === 0) return gap(`no active rule on ${DEFAULT_BRANCH} requires status checks`);
	const named = checks
		.map((rule) => ({ rule, full: (Array.isArray(rule.parameters?.required_status_checks) ? (rule.parameters!.required_status_checks as Required[]) : []).filter((c) => c?.context === FULL_SUITE_STATUS) }))
		.filter((x) => x.full.length > 0);
	if (named.length === 0) return gap(`no required status check on ${DEFAULT_BRANCH} names ${FULL_SUITE_STATUS}`);
	const open = named.filter((x) => x.full.some((c) => c!.integration_id === undefined || c!.integration_id === null));
	if (open.length === 0) return gap(`the required ${FULL_SUITE_STATUS} on ${DEFAULT_BRANCH} must come from an integration (integration_id), not the test runner`);
	const strict = open.filter((x) => x.rule.parameters?.strict_required_status_checks_policy === true).map((x) => x.rule);
	if (strict.length === 0) return gap(`the rule requiring ${FULL_SUITE_STATUS} on ${DEFAULT_BRANCH} is not strict (a branch need not be up to date)`);
	const gaps: string[] = [];
	let unread = false;
	for (const id of new Set(strict.map((r) => r.ruleset_id))) {
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
			gaps.push(`merging account can bypass ruleset ${String(id)} (no ruleset_id to read)`);
			continue;
		}
		let ruleset: { current_user_can_bypass?: unknown } | null;
		try {
			ruleset = readRuleset(id) as { current_user_can_bypass?: unknown } | null;
		} catch (err) {
			unread = true;
			gaps.push(`ruleset ${id} could not be read: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const bypass = ruleset?.current_user_can_bypass;
		if (bypass === "never") return { state: "ok" };
		if (typeof bypass !== "string" || BYPASS_MODES[bypass] !== true) {
			unread = true;
			gaps.push(`ruleset ${id} gave no usable current_user_can_bypass (${bypass === undefined ? "none" : JSON.stringify(bypass)})`);
			continue;
		}
		gaps.push(`merging account can bypass ruleset ${id} (${bypass})`);
	}
	return { state: unread ? "unknown" : "gap", text: gaps.join("; ") };
}

/**
 * Main's protection on `repo` read live (D2, PLAN wl-mvbjiettjrfpxc D6; `mainProtectionGap`): `read` is gh's JSON for `args`,
 * throwing on a failed call (the stakes script's and the train tick's gh): `api repos/<repo>/rules/branches/main`, then `api
 * repos/<repo>/rulesets/<id>` per ruleset holding a qualifying rule. A rules read that throws is `unknown`, never a gap.
 */
export function protectionGap(repo: string, read: (args: string[]) => unknown): Protection {
	let rules: unknown;
	try {
		rules = read(["api", `repos/${repo}/rules/branches/${DEFAULT_BRANCH}`]);
	} catch (err) {
		return { state: "unknown", text: err instanceof Error ? err.message : String(err) };
	}
	return mainProtectionGap(rules, (id) => read(["api", `repos/${repo}/rulesets/${id}`]));
}

/**
 * The question Jo answered `skip` on for PR `pr` on this train (§ 1, the skip in the close check), or null:
 * the workload is a merge train (`trainMembers`) and Jo's `skip` (author jo, written by the surface) resolves
 * a question on one of this train's slices of that PR. A lane-written answer, or a `skip` on a workload
 * that is no train, never counts. The close check treats such a PR like a closed one.
 */
export function trainSkippedOf(pr: number, entries: readonly EntryRow[], questions: readonly QuestionRow[], instructions: readonly InstructionRow[]): string | null {
	if (trainMembers(entries, instructions).length === 0) return null;
	const q = questions.find((x) => trainSlicePr(x.slice_id, x.workload_id) === pr && joAnswer(x, instructions, "skip") !== null);
	return q?.id ?? null;
}

/** Who put a train's first PRs on it, for its brief's header (PLAN wl-mvbjiettjrfpxc D3): Jo's `train` word, or the train tick's board. */
export type TrainSource = "jo" | "board";

/** The header of a train's brief: Jo's word or the tick's board, then the PRs it opened on. */
const TRAIN_HEADER: Record<TrainSource, string> = { jo: "merge train (Jo's word)", board: "merge train (auto-boarded by the train tick)" };

/** The line `stakes --hold-ok` prints for a normal PR whose main protection is unverified (PLAN wl-mvbjiettjrfpxc D5). */
export const HOLD_PREFIX = "hold: main protection unverified";

/**
 * The lane's brief for train `wl` opened on `prs` (§ 2, rev 17.1 parts 1 and 2; PLAN wl-mvbjiettjrfpxc D5): the header (`source`), each
 * first PR's slice ids, and the codified procedure, numbered, with the real slice ids of this train and the resolver's command.
 * Step 0 reads the train's members from `merge-train.ts list` (Jo's PRs and the tick's boards alike), and the lane records its
 * notes with lane_record_entry: the train sends Jo nothing but its questions. Steps 1 and 7b read `stakes --hold-ok`: a `hold:`
 * (main's protection unverified) or a second exit 2 is a `train-error:` pass-over with no question and no merge; `production:`
 * keeps Jo's merged / skip / stop question; a plan hold, `hold: <reason> until <time|jo>` (PLAN wl-mvfkv7llkp7nk0 § 3), gets a
 * lane-written `train-hold:` and is passed over, its slices open, until the tick's `hold-expired` wake. Step 6 takes a green, or a `red-main` (every failure also fails on main: the lane
 * files or finds the `main-red` issue, records `main-red:`, and goes on). Step 7 lands a green PR: one readiness check for both
 * stakes (the tested head, mergeable, main contained), the stakes read again, then a normal PR merges itself (merge with
 * `--match-head-commit`, verify, record) and a production PR's question goes through Jo's rulings (PLAN wl-mvg8itbt0rz3ls
 * D3): decided by `train-signoff`, the lane merges it at once as c. to e.; otherwise it is Jo's question while the train goes on. A moved head goes
 * back to step 2's fresh worktree, a moved main to step 3. A red, a conflict or a stack problem goes back to the PR's owner
 * through `lane_train_return` (D6), and the train passes over the PR; a second refused merge or runner error is a lane-written
 * `train-error:` the tick retries. Before done-because the lane reads `list` once more and works any PR it has not seen.
 */
export function trainBrief(wl: string, prs: readonly number[], source: TrainSource = "jo"): string {
	const k = wl.replace(/^wl-/, "");
	const sl = `sl-train-${k}-<n>`;
	const full = `${sl}-full-<r>`;
	const append = `\`train ${wl} <N…>\``;
	const list = `\`${RESOLVE_COMMAND} list --workload ${wl}\``;
	const lines = [
		`${TRAIN_HEADER[source]}: ${prs.map((n) => `#${n}`).join(", ")}`,
		"",
		`Train ${wl}. Its PRs are the lines ${list} prints (\`<n> jo\`: Jo's word, ${append} included; \`<n> board\`: the train tick ` +
			"boarded a green, reviewed lane PR), in that order; the header names only the first. " +
			"Work one PR at a time. No question holds the next PR: a production PR's question stays open while the train goes on, and a PR " +
			"the train cannot land goes back to its owner and is passed over (Returning a PR, below). Each PR's slices, as for these first ones:",
		...prs.map((n) => `- #${n}: ${trainSliceId(wl, n)}, suite runs on ${trainFullSliceId(wl, n, 1)}, ${trainFullSliceId(wl, n, 2)}, …`),
		"",
		`0. ${list} (read-only) for the PRs, then \`${RESOLVE_COMMAND} order --repo <owner/repo of this workload's origin> --prs <every PR list printed, in its order, comma-separated>\`, ` +
			"at train start and again before each PR, because a body can change. It prints the chain line (`#101 → #106 → #107 · #139`: " +
			"arrows join a stack, `·` separates independent PRs, `✓` a merged dependency, `⇠` a PR that waits), then JSON " +
			`\`{order, waiting, cycles, chain, unrecorded}\`. Work the PRs in its \`order\`. Record the chain line with ${LANE_RECORD_ENTRY_TOOL} at the start. ` +
			"For every `unrecorded` edge `{pr: B, dependsOn: A}` (B's base branch is A's head and B's body has no `Depends-on: #A` line), " +
			"at once, before A can merge: `gh pr edit B --body-file <a file holding B's body plus the line \"Depends-on: #A\">`, then run `order` again.",
		`1. Per PR n two slices, added with these exact ids (lane_add_slice \`id\`): \`${sl}\` (the PR's disposition: prep, stakes, outcome) ` +
			`and, once a push or the shortcut makes it testable, \`${full}\` for its suite runs, r counting from 1. ` +
			`A PR has at most one open full-suite slice: every run, retry, rerun, or rerun after a stale or error result goes on that open slice; ` +
			"add `-full-<r+1>` only when a green has completed `-full-<r>` and the PR needs a new run because main or its head moved. " +
			"`gh pr view <n> --json headRefName,headRefOid,state,mergeable,mergeStateStatus`; a merged or closed PR: complete " +
			`\`${sl}\` with artifact \`skipped: <state>\`. A head branch whose workload has a live lane is not touched this pass and is not terminal: ` +
			`leave its slices open and ${LANE_RECORD_ENTRY_TOOL} \`train-error: pr <n> live lane <id>\`; the tick retries ` +
			`it, and that later pass tests it on its open \`${full}\`. Then the next PR. Stakes: ` +
			`\`${RESOLVE_COMMAND} stakes --hold-ok --repo <owner/repo of this workload's origin> --pr <n>\` prints \`normal\` (a same-repo \`wl/<id>\` ` +
			`branch whose workload is on this repository at normal stakes, and main's protection verified), \`${HOLD_PREFIX} (<gap>)\` ` +
			"(the PR's own stakes are normal, but main's protection is not verified), `hold: <reason> until <time|jo>` (a normal " +
			"workload whose plan started without Jo's approve, held until <time>, or one Jo halted or has not answered yet, held until " +
			"`jo`) or `production: <reason>` (anything else); exit 2 (usage or a gh failure): run it once more. On " +
			`\`${HOLD_PREFIX} (<gap>)\`, or on a second exit 2: ` +
			`${LANE_RECORD_ENTRY_TOOL} \`train-error: pr <n> protection <gap>\` (or \`train-error: pr <n> stakes <the second run's message>\`) and pass the PR ` +
			`over: no question to Jo, no merge; the tick retries it. A \`hold: … until jo\` here: ${LANE_RECORD_ENTRY_TOOL} ` +
			"`train-hold: pr <n> head <the PR's current head, all 40 hex> until jo`, leave its slices open (it is not terminal) " +
			"and go on to the next PR; the tick wakes the train when the hold ends. A `hold: … until <time>` is prepared and tested as " +
			"normal: only its merge waits. Step 7 runs the command again before it decides. Before step 2: every dependency of n must " +
			"be MERGED, then a base-branch stack is retargeted (Stacked PRs, below); otherwise n is passed over as that rule says.",
		`2. \`git fetch origin\`; a PR worktree on a new branch at the PR's current head, new each time this step runs: \`${TRAIN_PREPARE.replace("<k>", k)}\`, ` +
			`where <a> is the first attempt number from 1 that \`git branch --list 'train/${k}-<n>-*'\` does not show yet (never \`--detach\`: ` +
			"row 8 refuses a detached HEAD's push). Never reuse an older PR worktree: its tree is an older head. " +
			"Run every resolver command below with that PR worktree as cwd (the script works on the repo of its cwd) and always your " +
			"lane worktree's copy of the script, never the PR branch's: an older PR branch may not have it. Run " +
			`\`${RESOLVE_COMMAND} check --base origin/main\`: exit 0 = no PR-added numbered MIGRATION.md item is left. If the head ` +
			"contains origin/main, `check` exits 0, and its last full suite at that head is green → step 7. If the head contains origin/main and " +
			"`check` exits 0 but the head is ahead of its last green only by decision-log commits (each touching only `.ai/decision-log/`, a " +
			`close's entry, say), it is tested by calling \`lane_full_test { pr: <n>, slice: ${full} }\` (the PR's open \`${full}\`, or the next r) with no push: ` +
			"a starter line ending ` carried <R>` means the slice is already green at that head (run R's green carried, no new run) → step 7; " +
			"any other answer spawned a run, and step 6's result handling applies as for any run.",
		"3. `git merge --no-ff origin/main` (a merge commit). Never rebase, never force-push.",
		`4. On conflict: \`${RESOLVE_COMMAND} resolve --pr <n> --workload <head workload>\`, where <head workload> is the head branch's ` +
			"workload id when the branch is `wl/<wl-…>`, else `none`. Exit 0: it wrote and staged MIGRATION.md / migration/items / " +
			"install/manifest.tsv; `git commit --no-edit`. Exit 3 (a conflict outside that set), 4 (one it cannot fix without losing " +
			"a side's edit) or 2 (a usage error or a git process failure, e.g. `git merge-file` crashed): `git merge --abort`, push nothing, " +
			"and return the PR with kind `conflict` (the files, the resolver's exit code and its message). The train never resolves a conflict by hand.",
		`5. Conversion commit: \`${RESOLVE_COMMAND} convert --pr <n> --workload <head workload> --base origin/main\`. When it wrote ` +
			"files, `git add` them and commit `migration: #<n>'s item to migration/items/<slug>.md`. Then `check` must exit 0, and " +
			"`git status --porcelain` must be empty.",
		"6. Declare the slice artifact (a bare `bun test surface/test/migration-items.test.ts`; the PR's changed test files run in `lane_full_test`, " +
			"outside the lane fence where lane tests' `ps` calls work, so this step does not run them), pass it " +
			`on that clean tree, then \`${TRAIN_PUSH}\` (no force) in a bash call of its own from the PR worktree (its cwd, or a leading \`cd\`). Use the PR's open \`${full}\`, or add the next r when ` +
			`none is open. Then \`lane_full_test { pr: <n>, slice: ${full} }\`; a green or a \`red-main\` completes that slice itself. Green → step 7; ` +
			"on a land-first repository (Jo's `land-first <owner/repo> on`: the runner checks a PR before merge with the fast check, the full suite " +
			"only by exception, and runs the full suite on main after) an answer or result ending ` fast` is the fast check's green, a green like " +
			"any other → step 7. The STATUS of a run is `gh api repos/<owner/repo>/commits/<the tested head>/statuses --jq " +
			"'[.[] | select(.context == \"as2/full-suite\")][0]'` (the newest `as2/full-suite` the runner posted). While landing is stopped on a " +
			"land-first repository (that STATUS is failure naming `landing stopped`, or the merge hold holds step 7 c.'s merge as a reserved action " +
			"for Jo), the PR is passed over: lane_record_entry `train-error: pr <n> landing-stopped <the reason the status or the hold names>`, " +
			"no question, no merge, no return to its owner; the tick wakes the train when landing reopens. A `red-main` never lands on a " +
			"land-first repository: its gate posts failure, so when that STATUS is failure, file nothing and merge nothing: lane_record_entry " +
			"`train-error: pr <n> red-main <run id>` and pass the PR over (main itself is red; the tick's main runs and repair handle it). " +
			"Otherwise, `red-main` (every failing test also fails in the runner's run of main's base, so the PR adds none; the result names base's sha): " +
			"`gh issue list -R <owner/repo> --label main-red --state open --search \"<the run's first failing test>\"`; when no issue matches, " +
			"`gh label create main-red -R <owner/repo> --force --description \"main is red (as2 merge train)\"` (--force: no failure when the label exists), then " +
			"`gh issue create -R <owner/repo> --label main-red --title \"main red: <the first failing test>\" --body-file <a file under $AS2_SCRATCH " +
			"with the run id, base's sha and the failing tests>`; then lane_record_entry `main-red: <issue url> run <id>` and step 7 as for a green. " +
			"The red-main result is what lets the PR merge; the entry and the issue are the record that main is red. " +
			`Every failure a known flake (${KNOWN_FLAKES.join(", ")}) → rerun once on the same slice. A runner \`stale\` because main or the ` +
			"head moved, or a runner `error` → back to step 2, keeping the same open slice for the next run; a second `error` at the same " +
			"head: lane_record_entry `train-error: pr <n> error <the run ids and their reasons>` and pass the PR over (the tick retries it). " +
			"Any other red, or a flake rerun red again: the train never fixes it; return the PR with kind `red` (run id, head, counts, the " +
			"failing test names and first error lines, the run's result.json path).",
		"7. Land the green PR, both stakes through a. and b. in order; only b.'s answer picks the merge or Jo's question:",
		"   a. Ready: `git fetch origin`, then `gh pr view <n> -R <owner/repo> --json headRefOid,mergeable,mergeStateStatus`. The head must " +
			"equal the sha the green run tested, `mergeable` must be `MERGEABLE` (an `UNKNOWN` is re-queried once and never read as " +
			"mergeable), and `git merge-base --is-ancestor origin/main <head>` must exit 0. A moved head (not the tested sha, a head " +
			"ahead of it only by decision-log commits included) → back to step 2 (a new PR worktree at the new head, and on from there, " +
			"where such a head is tested by lane_full_test, which may carry); never merge main into the older local tree. The tested " +
			"head not containing origin/main, or not `MERGEABLE` → back to step 3 (merge main in, push, a new suite run).",
		`   b. Stakes, again: run step 1's \`${RESOLVE_COMMAND} stakes --hold-ok\` command now, just before the merge; its answer decides, not step ` +
			"1's (the workload's stakes, its plan's hold or main's protection may have changed while the suite ran). `normal` → c. " +
			`\`${HOLD_PREFIX} (<gap>)\`, or a second exit 2 → record step 1's \`train-error:\` and pass the PR over, no question and no merge. ` +
			"`production: <reason>` → Production stakes, below. `hold: <reason> until <time|jo>` → no merge and no " +
			"question: lane_record_entry `train-hold: pr <n> head <the head a. read, all 40 hex> until <the line's own time or jo>`, leave " +
			"the PR's slices open (it is not terminal) and go on to the next PR; the tick wakes the train once the hold ends, and that pass works the PR from step 1.",
		"   c. Merge: `gh pr merge <n> -R <owner/repo> --merge --match-head-commit <head>`, a merge commit, never `--admin`, `--squash`, " +
			"`--rebase` or `--auto`. Main's protection, which b. verified (a strict rule requiring `as2/full-suite`, which the test runner " +
			"posts, in a ruleset the merging account can never bypass), makes GitHub refuse a merge whose head lacks the current main or a green status, so a race ends in a refused merge. " +
			"On a land-first repository the merge hold may hold this merge as a reserved action for Jo while the tick has not found landing open: " +
			"that is step 6's landing-stopped pass-over, never a reason to retry the merge another way.",
		"   d. Verify: `gh pr view <n> -R <owner/repo> --json state,mergeCommit` shows `MERGED`. The FIRST refused merge (gh exits non-zero, " +
			"or the state is not MERGED) → back to a. Only when a. then passes again on the same head, which has a green (head unchanged, " +
			`\`MERGEABLE\`, main contained), the head may lack its status (a carried green whose \`as2/full-suite\` post failed): add the next \`${sl}-full-<r+1>\` ` +
			"slice and call `lane_full_test` on it once. An answer ending ` carried <R>` (the starter posted the status again from the identical " +
			"green) → c. again; any other answer is a spawned run → step 6's result handling, never an assumed green. A moved head or main in a. " +
			"routes to step 2 or 3 as a. says, with no repair request. A second refusal on the same head: lane_record_entry `train-error: pr <n> merge-refused " +
			"<gh's messages>` and pass the PR over (the tick retries it).",
		`   e. Record: complete \`${sl}\` with artifact \`merged by train <merge commit sha> (run <id>)\`, then the next PR.`,
		`   Production stakes, reached only from b. after a. passed: raise the question on \`${sl}\`: PR green and mergeable at <the ` +
			"head a. read> on main <the origin/main a. fetched>, run <the green run at that head>, <pass>/<fail>/<skip>, b.'s stakes " +
			"reason, the chain, item file if any; options merged / skip / stop. The question goes through Jo's rulings: when " +
			"lane_raise_question answers `decided by Jo's ruling train-signoff` (Jo's train word on this PR is his sign-off), no question " +
			"was raised: do what it says at once, c. to e. with the head a. read, no question and no wait. Otherwise do not wait for it: go on to the next PR while it is " +
			`open. merged → \`gh pr view\` shows MERGED, complete \`${sl}\` with artifact \`merged by Jo <merge commit>\`; skip → Jo's ` +
			"answer cancels the PR's open train slices; stop → record it and release the lane with no done-because (slices stay open, " +
			`the workload stays open; Jo's ${append} relaunches it).`,
		"   Repair, step 7g (a land-first repository, a regression only): the tick wakes the train with `repair <T 7>` (the launch reason) when " +
			"main's run at tip T is red or implausible, and files the jo-issues issue `landing stopped on <owner/repo>` with G (the newest verified " +
			"commit), the suspects (main's first-parent merge commits after G up to T, each with its PR and workload), the failing files and the " +
			"attribution (which suspects' changes reach a failing test). One attempt per wake, before any other PR: " +
			"(1) when any suspect changed `ledger/schema.sql` or the `SCHEMA_VERSION` line of `ledger/src/index.ts` (`git show --stat <suspect>`, " +
			"`git show <suspect> -- ledger/src/index.ts`): no revert; comment on the issue that a schema migration needs a reviewed repair, " +
			"lane_record_entry `train-error: repair <T 7> schema <that suspect's sha>`, and stop the repair (the tick tells Jo). " +
			"(2) Otherwise, when the attribution names exactly one suspect and it is the only suspect, or names none, or names several: revert " +
			"every suspect, newest first, on a new branch `train/revert-<T 7>` from origin/main (`git revert -m 1 <merge sha>` each, in one " +
			"worktree), so the tree equals G's and carries G's green with no run; when it names exactly one of several suspects, revert only that " +
			"one, which takes the full suite on the Mac before landing. A revert conflict: `git revert --abort`, lane_record_entry " +
			"`train-error: revert <T 7> conflict <the files>`, stop the repair. (3) Push the branch, `gh pr create -R <owner/repo> --base main " +
			"--head train/revert-<T 7> --title \"revert: main red at <T 7>\" --body <the issue url and the reverted PRs>`, then work it like a train PR " +
			`(its own \`${sl}\` and \`${full}\` slices, lane_full_test, step 7 a. to e.); the gate posts \`repair: …\` success on it and the merge hold ` +
			"admits exactly that head once the tick's next pass names it. (4) On each reverted PR, `gh pr comment <n> -R <owner/repo> --body " +
			"<the failing tests and the issue url>`, and lane_record_entry `reverted: #<n> <its merge sha> repair <T 7>`. A fix PR an owner names " +
			"in the issue may land instead through the full suite. Never revert, retry or merge anything else for the incident: a second attempt is the tick's next wake or Jo's.",
		"",
		`Returning a PR to its owner (no question to Jo): write the detail to a file under \`$AS2_SCRATCH\`, then \`${LANE_TRAIN_RETURN_TOOL} ` +
			"{ pr: <n>, kind: red | conflict | stack, detail: <absolute path of the detail file> }`. It records the task on this workload " +
			"(`train-task:`, with the PR's owner and its attempt); the train tick delivers it to the owner and settles it. Then the next PR. A " +
			"returned PR's slices stay open, and a PR with an unsettled task is not worked again: its owner is on it. Once the task is settled " +
			"(`train-task-settled:`), the train's next pass works the PR from step 1 at its current head: green → merge; red, conflict or " +
			`stack → return it again (the tool sets the next attempt). When ${LANE_TRAIN_RETURN_TOOL} refuses because attempt 2 settled failed, pass the ` +
			"PR over: the tick raises Jo's alert. A PR passed over with `train-error:` is worked again on a later pass.",
		"Rules: one live run per workload; no code edit beyond the resolver's output; merge only at step 7 c., on b.'s `normal` or Jo's " +
			"ruling train-signoff deciding the production question, as a merge commit; a production PR's merge is Jo's: his merged answer, " +
			"or his ruling train-signoff deciding the question; a held PR is never merged while its hold stands. Record per PR with lane_record_entry: stakes and reason, head tested, run id, " +
			"verdict and counts, item file written if any, and its outcome.",
		`The train's stop: after Jo answers stop on a question on one of this train's slices, the test runner refuses lane_full_test for every PR until Jo's next ${append}. No other question holds a run.`,
		`Terminal outcomes: \`${sl}\` completed (\`merged by train …\`, \`merged by Jo …\`, \`skipped: <state>\`) ` +
			`or cancelled by Jo's skip, and no open \`${full}\`. Before done-because, run ${list} once more and work every PR it prints ` +
			"that this pass has not seen (the tick may have boarded one while you worked). done-because when every PR on the train is terminal, listing each; with no " +
			"open slice left the orchestrator's close is not refused. When nothing on the train is runnable and a production question is " +
			`open, stop and let the lane wait on it; Jo's answer resumes it. When nothing is runnable and no question is open, ${LANE_RECORD_ENTRY_TOOL} one ` +
			"entry listing each PR that is not terminal with its unsettled task or newest `train-error:` or `train-hold:`, then release with no done-because. " +
			`The train sends Jo nothing but its questions: every note it leaves is a ${LANE_RECORD_ENTRY_TOOL} entry.`,
		"Stacked PRs: a PR depends on #A when its body has a `Depends-on: #A` line (the edge the lane records, or the author's) or its " +
			"base branch is #A's head. The chain line goes in every production question and every returned PR's detail (\"chain: #101 → **#106** → #107\", " +
			"the PR at hand in bold) and in done-because. The test runner refuses lane_full_test for a train PR whose `Depends-on:` PR is " +
			"not MERGED or whose base branch is not main. Once #A is merged, and before #B's step 2: `gh pr edit B --base main` unless " +
			"GitHub already retargeted B; merging main into B then brings in A's merge commit. A PR in `waiting` is passed over with no " +
			"entry and tried again on each pass, once a PR ahead of it lands. A cycle member, a PR whose dependency Jo skipped, closed " +
			"unmerged or is not on the train, and a PR whose retarget the gate refuses: return it with kind `stack` (the chain and the " +
			"problem). Never add a PR to the train, nor a `Depends-on:` line beyond an `unrecorded` edge, without Jo's word.",
	];
	return lines.join("\n");
}

// ---- part 2: a PR goes back to its owner (rev 17.1 D6-D8) --------------------------------------

/** What `lane_train_return` returns a PR for (D6): a red suite, a conflict the resolver cannot fix, a stack problem. */
export const TRAIN_TASK_KINDS = ["red", "conflict", "stack"] as const;
export type TrainTaskKind = (typeof TRAIN_TASK_KINDS)[number];
/** The attempts a PR gets (D8): when attempt 2 settles failed, the train raises Jo's alert (D9) instead of issuing attempt 3. */
export const TRAIN_MAX_ATTEMPTS = 2;
/** D8's no-push rule: a task with no push for this long since its creation, or since the owner's last push, settles failed. */
export const TRAIN_NO_PUSH_MS = 2 * 3_600_000;
/** The most detail one task carries: the first failures and errors (D6), never a whole log. */
export const TRAIN_DETAIL_MAX_BYTES = 16_384;
/** A fix workload's `done:` line (D8, owner none). */
export const TRAIN_FIX_DONE = "The merge-train task on this PR is settled (fixed at a new head, or failed), and done-because names the task and its outcome.";

/** One `train-task:` on a train (D6), parsed. */
export interface TrainTask {
	id: string;
	/** The `train-task:` entry on the train. */
	entryId: string;
	train: string;
	pr: number;
	attempt: number;
	kind: TrainTaskKind;
	/** H0: the PR's head when the train returned it. */
	head: string;
	/** The owning workload by D1's rule (`taskOwner`), or null for `owner none`. */
	owner: string | null;
	detail: string;
	/** t0. */
	createdAt: string;
}

const TASK_LINE_RE = /^(tt-[a-z0-9]+) pr ([1-9]\d*) attempt ([1-9]\d*) kind (red|conflict|stack) head ([0-9a-f]{40}) owner (wl-[a-z0-9]+|none)$/;

/** `train-task: <tt-…> pr <n> attempt <a> kind <k> head <sha> owner <wl-…|none>`, the detail on the lines after it. */
export function trainTaskBody(t: Pick<TrainTask, "id" | "pr" | "attempt" | "kind" | "head" | "owner" | "detail">): string {
	return `train-task: ${t.id} pr ${t.pr} attempt ${t.attempt} kind ${t.kind} head ${t.head} owner ${t.owner ?? "none"}\n${t.detail}`;
}

/** Every valid `train-task:` among a train's control entries (read with its holders, `controlEntries`), oldest first; a repeated id keeps the first. */
export function parseTrainTasks(train: string, control: readonly ControlEntry[]): TrainTask[] {
	const out: TrainTask[] = [];
	for (const c of control) {
		if (c.prefix !== "train-task") continue;
		const nl = c.rest.indexOf("\n");
		const m = TASK_LINE_RE.exec((nl < 0 ? c.rest : c.rest.slice(0, nl)).trim());
		if (!m || out.some((t) => t.id === m[1])) continue;
		out.push({
			id: m[1]!, entryId: c.id, train, pr: Number(m[2]), attempt: Number(m[3]), kind: m[4] as TrainTaskKind, head: m[5]!,
			owner: m[6] === "none" ? null : m[6]!, detail: nl < 0 ? "" : c.rest.slice(nl + 1).trim(), createdAt: c.createdAt,
		});
	}
	return out;
}

/** A task's one terminal outcome (D8): `train-task-settled: <tt-…> fixed|failed <evidence>`, the train tick's (MERGE_TRAIN_BY). */
export interface TaskSettle {
	taskId: string;
	outcome: "fixed" | "failed";
	evidence: string;
	entryId: string;
	createdAt: string;
}

export function trainTaskSettledBody(taskId: string, outcome: TaskSettle["outcome"], evidence: string): string {
	return `train-task-settled: ${taskId} ${outcome} ${evidence.replace(/\s+/g, " ").trim()}`;
}

const SETTLED_RE = /^(tt-[a-z0-9]+) (fixed|failed)(?:\s+([\s\S]*))?$/;

/** Each task's settle among a train's control entries; the first one per task is its outcome, a later one is ignored. */
export function taskSettles(control: readonly ControlEntry[]): Map<string, TaskSettle> {
	const out = new Map<string, TaskSettle>();
	for (const c of control) {
		const m = c.prefix === "train-task-settled" ? SETTLED_RE.exec(c.rest) : null;
		if (!m || out.has(m[1]!)) continue;
		out.set(m[1]!, { taskId: m[1]!, outcome: m[2] as TaskSettle["outcome"], evidence: (m[3] ?? "").trim(), entryId: c.id, createdAt: c.createdAt });
	}
	return out;
}

/** A workload's control entries read with its holders, so a holder's `train-task:`, `push-dest:` or `done-because:` counts. */
function controlOf(ledger: Ledger, wl: string): ControlEntry[] {
	const entries = ledger.entries(wl);
	return controlEntries(entries, holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)));
}

/** The workloads carrying an entry by `by` whose body starts with `prefix`, open ones only unless `closed`, oldest first. */
function withEntry(ledger: Ledger, by: string, prefix: string, closed = false): string[] {
	return ledger.db.query<{ id: string }, [string, string, number]>(
		`SELECT w.id AS id FROM workloads w WHERE (?3 OR w.status = 'open') AND EXISTS (
		   SELECT 1 FROM entries e WHERE e.workload_id = w.id AND e.kind = 'assumption' AND e.created_by = ?1 AND substr(e.body, 1, length(?2)) = ?2)
		 ORDER BY w.created_at, w.id`,
	).all(by, prefix, closed ? 1 : 0).map((r: { id: string }) => r.id);
}

/** Every open merge train: an open workload with a surface `train:` or a merge-train `train-board:` that is a valid member (`trainMembers`). */
export function openTrains(ledger: Ledger): string[] {
	return ledger.db.query<{ id: string }, [string, string]>(
		`SELECT w.id AS id FROM workloads w WHERE w.status = 'open' AND EXISTS (
		   SELECT 1 FROM entries e WHERE e.workload_id = w.id AND e.kind = 'assumption' AND (
		     (e.created_by = ?1 AND substr(e.body, 1, 6) = 'train:') OR (e.created_by = ?2 AND substr(e.body, 1, 12) = 'train-board:')))
		 ORDER BY w.created_at, w.id`,
	).all(SURFACE_BY, MERGE_TRAIN_BY).map((r) => r.id).filter((wl) => trainPrs(ledger.entries(wl), ledger.instructions(wl)).length > 0);
}

/** The surface's `repo:` checkout of workload `wl`, resolved through symlinks when it exists; null when it has none. */
export function trainCheckout(ledger: Ledger, wl: string): string | null {
	const path = controlEntries(ledger.entries(wl)).filter((c) => c.prefix === "repo").at(-1)?.rest ?? null;
	if (path === null) return null;
	try {
		return canonicalPath(path);
	} catch {
		return path;
	}
}

/**
 * A checkout's repository identity (rev 17.1 D8, the one-train rule): the GitHub `owner/repo` of its origin, compared without
 * case as D1 and `openTrainFix` compare it, so any checkout or subdirectory of one GitHub repository is that repository; a
 * checkout with no GitHub origin is only itself, by its canonical path.
 */
export function repoIdentity(path: string): string {
	const origin = checkoutOwnerRepo(path);
	if (origin !== null) return `github ${origin.toLowerCase()}`;
	try {
		return `path ${canonicalPath(path)}`;
	} catch {
		return `path ${path}`;
	}
}

/**
 * The first PR among `prs` already on an open merge train other than `except` of the same repository as checkout `repo`
 * (`repoIdentity`; rev 17.1 D8: a PR is on at most one open train, so it has one task stream), with that train; null when
 * none is. A PR Jo skipped on that train (`trainSkippedOf`) is off it, so the skip's way back, a new `train <N>`, stays open.
 */
export function onOtherTrain(ledger: Ledger, repo: string, prs: readonly number[], except: string | null = null): { pr: number; train: string } | null {
	const want = repoIdentity(repo);
	for (const train of openTrains(ledger)) {
		const checkout = train === except ? null : trainCheckout(ledger, train);
		if (checkout === null || repoIdentity(checkout) !== want) continue;
		const entries = ledger.entries(train);
		const instructions = ledger.instructions(train);
		const on = trainPrs(entries, instructions);
		const questions = ledger.questions(train);
		const pr = prs.find((n) => on.includes(n) && trainSkippedOf(n, entries, questions, instructions) === null);
		if (pr !== undefined) return { pr, train };
	}
	return null;
}

/** One `train-fix:` on a fix workload. */
export interface FixBinding extends TrainFix {
	workloadId: string;
	entryId: string;
}

/** Every `train-fix:` on an open workload (the tick's, MERGE_TRAIN_BY), oldest workload first; on closed ones too with `closed`. */
export function fixBindings(ledger: Ledger, opts: { closed?: boolean } = {}): FixBinding[] {
	return withEntry(ledger, MERGE_TRAIN_BY, "train-fix:", opts.closed).flatMap((wl) =>
		controlEntries(ledger.entries(wl)).flatMap((c) => {
			const f = c.prefix === "train-fix" ? parseTrainFix(c.rest) : null;
			return f ? [{ ...f, workloadId: wl, entryId: c.id }] : [];
		}));
}

/** Fix binding `f` binds PR `pr` on `train`: it names both, and its `train-entry` is a membership entry on that train listing the PR (`trainBindings`), as `boundPrs` rules. */
export function fixBinds(ledger: Pick<Ledger, "entries" | "instructions">, f: FixBinding, train: string, pr: number): boolean {
	return f.train === train && f.pr === pr && trainBindings(ledger.entries(train), ledger.instructions(train)).some((b) => b.entryId === f.trainEntry && b.prs.includes(pr));
}

/**
 * The workloads that own task `t`: its D1 owner, and every fix workload bound to its train and PR (owner none, or an owner closed
 * since; `fixBinds`).
 */
function taskOwners(ledger: Ledger, t: TrainTask, fixes: readonly FixBinding[]): string[] {
	const out = t.owner === null ? [] : [t.owner];
	for (const f of fixes) if (!out.includes(f.workloadId) && fixBinds(ledger, f, t.train, t.pr)) out.push(f.workloadId);
	return out;
}

/** The tasks on train `wl` with no settle yet, oldest first. */
export function unsettledTasks(ledger: Ledger, wl: string): TrainTask[] {
	const control = controlOf(ledger, wl);
	const settles = taskSettles(control);
	return parseTrainTasks(wl, control).filter((t) => !settles.has(t.id));
}

/** PR `pr`'s next attempt on train `wl` (D8): 1 + its tasks' failed settles written after Jo's last `retry` (D9's alert answer on one of its slices). */
export function nextAttempt(ledger: Ledger, wl: string, pr: number): number {
	const instructions = ledger.instructions(wl);
	let since: string | null = null;
	for (const q of ledger.questions(wl)) {
		const ins = trainSlicePr(q.slice_id, wl) === pr ? joAnswer(q, instructions, "retry") : null;
		if (ins && (since === null || ins.created_at > since)) since = ins.created_at;
	}
	const control = controlOf(ledger, wl);
	const settles = taskSettles(control);
	const failed = parseTrainTasks(wl, control).filter((t) => {
		const s = t.pr === pr ? settles.get(t.id) : undefined;
		return s?.outcome === "failed" && (since === null || s.createdAt > since);
	});
	return 1 + failed.length;
}

/** The `--json` fields `lane_train_return` reads from `gh pr view <n>`: D1's fields and the head. */
export const TASK_VIEW_FIELDS = "number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner";

export interface TaskView extends StakesView {
	headRefOid: string;
}

/** `gh pr view --json TASK_VIEW_FIELDS`'s output as a TaskView, or null when it is not that shape. */
export function taskViewOf(json: unknown): TaskView | null {
	if (typeof json !== "object" || json === null) return null;
	const v = json as Record<string, unknown>;
	const named = (o: unknown, key: string): boolean => o === null || (typeof o === "object" && typeof (o as Record<string, unknown>)[key] === "string");
	const repo = v.headRepository ?? null;
	const owner = v.headRepositoryOwner ?? null;
	if (typeof v.number !== "number" || typeof v.headRefName !== "string" || typeof v.headRefOid !== "string" || typeof v.isCrossRepository !== "boolean" ||
		!named(repo, "name") || !named(owner, "login")) return null;
	return {
		number: v.number, headRefName: v.headRefName, headRefOid: v.headRefOid, isCrossRepository: v.isCrossRepository,
		headRepository: repo as StakesView["headRepository"], headRepositoryOwner: owner as StakesView["headRepositoryOwner"],
	};
}

export interface TaskInput {
	/** The train workload. */
	train: string;
	/** The lane holding the train: the entry's writer. */
	by: string;
	pr: number;
	kind: TrainTaskKind;
	/** The detail file's content. */
	detail: string;
	view: TaskView;
	/** The train's repository, `owner/repo`. */
	trainRepo: string;
}

/**
 * `lane_train_return`'s write (D6): one `train-task:` on the train, as the lane holding it. Refused when the PR is not on the
 * train, already has an unsettled task, its attempt 2 settled failed (Jo's alert is due, D8), or a retry / skip / stop alert on
 * its slice is open (Jo decides first, D9); when the view is not that
 * PR or carries no full head sha; and when the detail is empty or over TRAIN_DETAIL_MAX_BYTES. The owner is D1's (`taskOwner`),
 * the attempt `nextAttempt`, the head the PR's current one. Nothing outside the ledger: delivery is the tick's (D10).
 */
export function recordTrainTask(ledger: Ledger, input: TaskInput): { ok: true; task: TrainTask } | { ok: false; reason: string } {
	const { train, pr, kind, view } = input;
	const no = (reason: string) => ({ ok: false as const, reason });
	if (!TRAIN_TASK_KINDS.includes(kind)) return no(`kind ${kind} is not one of ${TRAIN_TASK_KINDS.join(", ")}`);
	if (view.number !== pr) return no(`gh pr view answered #${view.number}, not #${pr}`);
	if (!SHA_RE.test(view.headRefOid)) return no(`#${pr}'s head ${view.headRefOid || "(none)"} is not a full sha`);
	const detail = input.detail.trim();
	if (!detail) return no("the detail file is empty");
	if (Buffer.byteLength(detail, "utf8") > TRAIN_DETAIL_MAX_BYTES) return no(`the detail is over ${TRAIN_DETAIL_MAX_BYTES} bytes; keep the first failures and errors`);
	// D1's lookup reads git (the owner checkout's origin), so it runs before the write lock.
	const owner = taskOwner(view, input.trainRepo, ledger);
	return ledger.write(() => {
		if (!trainPrs(ledger.entries(train), ledger.instructions(train)).includes(pr)) return no(`#${pr} is not on merge train ${train}`);
		const open = unsettledTasks(ledger, train).find((t) => t.pr === pr);
		if (open) return no(`#${pr} already has unsettled task ${open.id} (attempt ${open.attempt}); the tick settles it before the PR is returned again`);
		const attempt = nextAttempt(ledger, train, pr);
		if (attempt > TRAIN_MAX_ATTEMPTS) return no(`#${pr}'s attempt ${attempt - 1} settled failed: Jo's alert (retry / skip / stop) is due, not attempt ${attempt}; pass the PR over`);
		const alert = openRetryQuestion(ledger, train, pr);
		if (alert) return no(`#${pr}'s alert ${alert.id} (retry / skip / stop) is open: Jo decides before the PR is returned again; pass the PR over`);
		const t = { id: `tt-${newId("entry").slice(3)}`, pr, attempt, kind, head: view.headRefOid, owner, detail };
		const entryId = ledger.recordEntry({ by: input.by, workloadId: train, kind: "assumption", body: trainTaskBody(t) });
		return { ok: true as const, task: { ...t, entryId, train, createdAt: ledger.entry(entryId)!.created_at } };
	});
}

/** One push to a PR's head branch (D8's push evidence): the sha it pushed (`after`) and GitHub's time of the push. */
export interface TrainPush {
	sha: string;
	at: string;
}

/**
 * `gh api` for every push to `branch` of `repo` (`owner/repo`): GitHub's repository activity
 * (`GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`), every page (`--paginate --slurp`, an array of pages).
 * Every activity but a deletion moves the head to its `after` sha (`push`, `force_push`, `pr_merge`, `merge_queue_merge`,
 * `branch_creation`), so the listing is not filtered to one activity type and `trainPushesOf` keeps all of them.
 */
export function trainActivityArgs(repo: string, branch: string): string[] {
	return ["api", `repos/${repo}/activity`, "--method", "GET", "--paginate", "--slurp", "-f", `ref=refs/heads/${branch}`, "-f", "per_page=100"];
}

/** The one activity type that leaves no head behind; its `after` is the zero sha. */
const NO_HEAD_ACTIVITY = "branch_deletion";
const ZERO_SHA_RE = /^0+$/;

/**
 * `trainActivityArgs`' output as pushes to `branch`, oldest first; null when it is not that shape (pages of activity objects,
 * each push with a sha `after`, a `timestamp` and the branch's ref), so a listing the tick cannot read is no evidence.
 */
export function trainPushesOf(json: unknown, branch: string): TrainPush[] | null {
	if (!Array.isArray(json) || !json.every(Array.isArray)) return null;
	const out: TrainPush[] = [];
	for (const a of json.flat() as unknown[]) {
		if (typeof a !== "object" || a === null) return null;
		const type = Reflect.get(a, "activity_type");
		if (typeof type !== "string") return null;
		if (type === NO_HEAD_ACTIVITY) continue;
		const sha = Reflect.get(a, "after");
		const ts = Reflect.get(a, "timestamp");
		const ref = Reflect.get(a, "ref");
		if (typeof sha !== "string" || !SHA_RE.test(sha) || typeof ts !== "string" || Number.isNaN(Date.parse(ts)) || typeof ref !== "string") return null;
		if (ref !== `refs/heads/${branch}` && ref !== branch) continue;
		if (ZERO_SHA_RE.test(sha)) continue;
		out.push({ sha, at: new Date(Date.parse(ts)).toISOString() });
	}
	return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** GitHub's get-a-commit lists at most this many files across its pages (300 a page): a commit listing this many may have more. */
export const COMMIT_FILES_CAP = 3000;

/** The statuses GitHub's compare answers; any other is a misshapen answer. */
const COMPARE_STATUSES: Record<CompareResult["status"], true> = { identical: true, ahead: true, behind: true, diverged: true };

/** `json[key]` when `json` is an object, else undefined. */
const jsonField = (json: unknown, key: string): unknown => (typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined);

/**
 * The `CompareResult` of `from`..`to` on `repo` as GitHub answers it (PLAN wl-mvpwkpqobyp20w D1), for `decisionLogFault` to judge:
 * it decides nothing. `gh api repos/<r>/compare/<from>...<to>` gives the status, `total_commits` and each commit's sha and parent
 * count; each single-parent commit's own files come from every page of `gh api repos/<r>/commits/<sha> --paginate --slurp` (never
 * the net diff), a rename contributing the path it left as well as the one it made; a merge's files are not read. `from === to`
 * is `identical` with no gh call. What GitHub cannot answer completely is `ok: false` with its reason: a compare listing fewer
 * commits than `total_commits`, a commit listing COMMIT_FILES_CAP files (it may have more GitHub does not list), a rename that
 * names no previous path. `ghJson` is gh's JSON for `args` and throws on a failed call; a misshapen answer throws too.
 */
export function ghCompare(
	repo: string, from: string, to: string, ghJson: (args: string[]) => unknown,
): { ok: true; compare: CompareResult } | { ok: false; reason: string } {
	if (from === to) return { ok: true, compare: { status: "identical", commits: [] } };
	const cmp = ghJson(["api", `repos/${repo}/compare/${from}...${to}`]);
	const [status, listed, total] = [jsonField(cmp, "status"), jsonField(cmp, "commits"), jsonField(cmp, "total_commits")];
	if (typeof status !== "string" || !Object.hasOwn(COMPARE_STATUSES, status) || !Array.isArray(listed) || typeof total !== "number") {
		throw new Error(`gh api repos/${repo}/compare/${from}...${to} returned an unexpected shape`);
	}
	if (status !== "ahead") return { ok: true, compare: { status: status as CompareResult["status"], commits: [] } };
	if (listed.length !== total) return { ok: false, reason: `${to} is ${total} commits ahead of ${from}, more than the compare lists (${listed.length})` };
	const commits: RangeCommit[] = [];
	for (const c of listed as unknown[]) {
		const [sha, parents] = [jsonField(c, "sha"), jsonField(c, "parents")];
		if (typeof sha !== "string" || !SHA_RE.test(sha) || !Array.isArray(parents)) throw new Error(`gh api repos/${repo}/compare listed a commit with no sha or parents`);
		if (parents.length !== 1) {
			commits.push({ sha, parents: parents.length, files: [] });
			continue;
		}
		// Every page of the commit's files: an array of pages, each the commit object with its share of `files`.
		const pages = ghJson(["api", `repos/${repo}/commits/${sha}`, "--paginate", "--slurp"]);
		const lists = Array.isArray(pages) && pages.length > 0 ? (pages as unknown[]).map((p) => jsonField(p, "files")) : null;
		if (lists === null || !lists.every(Array.isArray)) throw new Error(`gh api repos/${repo}/commits/${sha} returned an unexpected shape`);
		const entries = (lists as unknown[][]).flat();
		if (entries.length >= COMMIT_FILES_CAP) return { ok: false, reason: `commit ${sha} lists ${entries.length} files, the most GitHub lists; its other files cannot be read` };
		const files: string[] = [];
		for (const f of entries) {
			const [name, prev] = [jsonField(f, "filename"), jsonField(f, "previous_filename")];
			if (typeof name !== "string") throw new Error(`gh api repos/${repo}/commits/${sha} listed a file with no filename`);
			files.push(name);
			// A rename touches the path it left as well as the one it made; a rename that names no previous path fails closed.
			if (prev === undefined && jsonField(f, "status") !== "renamed") continue;
			if (typeof prev !== "string") return { ok: false, reason: `commit ${sha} renames ${name} from no listed path` };
			files.push(prev);
		}
		commits.push({ sha, parents: 1, files });
	}
	return { ok: true, compare: { status: "ahead", commits } };
}

/**
 * What the tick knows from GitHub when it settles: each PR's current head (`gh pr view <n> --json headRefOid`), and the pushes
 * to its head branch (`trainActivityArgs`). A PR missing from `heads` cannot settle fixed this pass; one missing from `pushes`
 * (the listing failed or was unreadable) has no push evidence this pass, so no push-based rule settles it. `compares` holds
 * `ghCompare`'s result for each pair `carryPairs` lists, keyed `<S> <head>`: a pair missing from it (the fetch failed or GitHub
 * could not answer completely) is no compare, so no green carries over it (PLAN wl-mvpwkpqobyp20w D2).
 */
export interface SettleFacts {
	train: string;
	heads: ReadonlyMap<number, string>;
	pushes: ReadonlyMap<number, readonly TrainPush[]>;
	compares: ReadonlyMap<string, CompareResult | null>;
}

interface SettleEvent {
	at: string;
	outcome: TaskSettle["outcome"];
	evidence: string;
}

/** The runner results on task `t`'s owners for its PR requested after t0, oldest request first, each with its result when it has one. */
function taskRuns(ledger: Ledger, t: TrainTask, owners: readonly string[]) {
	return owners.flatMap((o) => testRuns(ledger.entries(o)).filter((r) => r.request.pr === t.pr && r.request.createdAt > t.createdAt))
		.sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
}

/**
 * Task `t`'s first terminal event among its owners' rows, or null while none has happened (D8). `pushes` is GitHub's record of
 * pushes to the PR's head branch (`SettleFacts.pushes`), undefined when this pass could not read it; `compares` is
 * `SettleFacts.compares`.
 */
function settleEvent(
	ledger: Ledger, t: TrainTask, owners: readonly string[], head: string | null, pushes: readonly TrainPush[] | undefined, compares: SettleFacts["compares"], now: string,
): SettleEvent | null {
	const t0 = t.createdAt;
	const events: SettleEvent[] = [];
	// The first runner result requested after t0 that is not an error decides; stale and superseded runs settle nothing either.
	// A green (or red-main) decides only at a head other than H0 that is the PR's current head; a green at S, not H0, also
	// decides when it is the task's NEWEST request's own result and the current head descends from S only by decision-log
	// commits (`decisionLogFault` on GitHub's compare of S and the head, PLAN wl-mvpwkpqobyp20w D2). A later request of any
	// kind (pending, red, error) means no carry from S: that request's result is what is read next. Until then the next result is read.
	const runs = taskRuns(ledger, t, owners);
	for (const r of runs) {
		const res = r.result;
		if (!res) continue;
		if (res.verdict === "red") {
			events.push({ at: res.createdAt, outcome: "failed", evidence: `run ${res.runId} red at ${res.sha}` });
			break;
		}
		if (SETTLING_VERDICTS.includes(res.verdict) && res.sha !== t.head && res.sha === head) {
			events.push({ at: res.createdAt, outcome: "fixed", evidence: `run ${res.runId} ${res.verdict} at ${res.sha}` });
			break;
		}
		if (r === runs.at(-1) && carries(res.verdict, res.sha, t, head) && decisionLogFault(compares.get(`${res.sha} ${head}`) ?? null) === null) {
			events.push({ at: res.createdAt, outcome: "fixed", evidence: `run ${res.runId} green at ${res.sha}, head ${head} decision-log only` });
			break;
		}
	}
	// A push is GitHub's record of one (D8): the repository activity on the head branch, at GitHub's time, after t0 (to the second
	// GitHub stamps) and of a sha other than H0. A runner request's time is when the owner asked for a run, not when it pushed, and
	// row 8's `push-dest:` is written before the push runs: neither is read here. The record is evidence only when it accounts for
	// the PR's current head: a head off H0 that no listed push names means GitHub's record is behind, so this pass has none.
	const t0s = new Date(Math.floor(Date.parse(t0) / 1000) * 1000).toISOString();
	const known = pushes !== undefined && head !== null && (head === t.head || pushes.some((p) => p.sha === head));
	const since = known ? pushes.filter((p) => p.sha !== t.head && p.at >= t0s).map((p) => p.at).sort() : null;
	const failedBody = new RegExp(`^${TRAIN_TASK_FAILED_PREFIX}\\s+${t.id}(?:\\s|$)`);
	const exits: string[] = [];
	for (const o of owners) {
		const entries = ledger.entries(o);
		const holders = holdersOf(entries, ledger.workload(o)?.holder ?? null, ledger.holders(o));
		const gaveUp = entries.find((e) => e.kind === "assumption" && holders.includes(e.created_by) && failedBody.test(e.body.trim()));
		if (gaveUp) events.push({ at: gaveUp.created_at, outcome: "failed", evidence: `owner ${o} wrote ${gaveUp.id}: ${gaveUp.body.trim()}` });
		const control = controlEntries(entries, holders);
		exits.push(...control.filter((c) => c.prefix === "lane-exit" && c.createdAt > t0).map((c) => c.createdAt));
		const exit = since === null ? undefined : control.find((c) => c.prefix === "lane-exit" && c.createdAt > t0 && !since.some((p) => p <= c.createdAt));
		if (exit) events.push({ at: exit.createdAt, outcome: "failed", evidence: `lane ${exit.laneId} on ${o} exited (${exit.rest}) with no push since the task` });
	}
	// The first stretch of 2 h with no push, from t0 or a push to the next push (or now), fails the task at its 2 h mark, even
	// when a later push came: a tick that ran late does not erase a deadline that passed.
	const marks = since === null ? [] : [t0, ...since];
	for (let i = 0; i < marks.length; i++) {
		const quiet = new Date(Date.parse(marks[i]!) + TRAIN_NO_PUSH_MS).toISOString();
		if (quiet <= (marks[i + 1] ?? now)) {
			events.push({ at: quiet, outcome: "failed", evidence: `no push for 2 h since ${marks[i]}` });
			break;
		}
	}
	const first = events.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
	// With no push evidence, a push-based failure may have come first: from t0's 2 h mark or an owner's exit on. A fixed at or
	// after the earliest of those waits for the evidence; a failed one is failed either way.
	if (first?.outcome === "fixed" && since === null) {
		const bound = [new Date(Date.parse(t0) + TRAIN_NO_PUSH_MS).toISOString(), ...exits].sort()[0]!;
		if (first.at >= bound) return null;
	}
	return first;
}

/**
 * The settles the tick writes now on train `facts.train` (D8): the `train-task-settled:` bodies, one per unsettled task whose
 * first terminal event has happened. fixed: the first non-error runner result requested after t0 on the owner is green at a
 * head other than H0 that is the PR's current head, or the task's newest request is green at S (not H0) with the current head
 * past S only by decision-log commits (`decisionLogFault` on `facts.compares`' `<S> <head>`, PLAN wl-mvpwkpqobyp20w D2). failed: that result is red; the owner's holder wrote
 * `train-task-failed: <id>`; an owner lane exited with no push before it; or some stretch of 2 h since t0 had no push. A push
 * is one GitHub records on the head branch (`facts.pushes`, at GitHub's time), never a runner request or row 8's `push-dest:`;
 * with no record this pass, or one that does not name the PR's current head, the two push rules wait. An `error` result never
 * settles and is never an attempt. A settled task is never settled again.
 */
export function settleTasks(ledger: Ledger, facts: SettleFacts, now: string): string[] {
	const fixes = fixBindings(ledger);
	return unsettledTasks(ledger, facts.train).flatMap((t) => {
		const e = settleEvent(ledger, t, taskOwners(ledger, t, fixes), facts.heads.get(t.pr) ?? null, facts.pushes.get(t.pr), facts.compares, now);
		return e ? [trainTaskSettledBody(t.id, e.outcome, e.evidence)] : [];
	});
}

/** An open full-suite slice whose PR's train work has ended, for the tick to cancel (`endedFullSlices`). */
export interface EndedFullSlice {
	slice: string;
	workloadId: string;
	pr: number;
	why: string;
}

/**
 * The open full-suite slices on train `wl` and its fix workloads whose PR's train work has ended, for the tick to cancel as
 * MERGE_TRAIN_BY. Only a green or red-main completes a full-suite slice (SETTLING_VERDICTS), and a lane never settles one, so
 * a red left it open for a next run; once no next run is coming, nothing else settles it, and it holds its workload's close
 * (the surface tick's "finished but cannot close") and the train's done line (#378's fix workload, #377 merged outside the train).
 * - The train's own `sl-train-<k>-<n>-full-<r>`, once PR n's disposition slice is done or cancelled (merged, closed, skipped).
 *   A settled task alone does not end it: the train's lane runs every attempt's suite on the PR's open full-suite slice.
 * - On each fix workload bound to PR n on `wl` (`fixBinds`), every open slice a runner request for n names, once n's
 *   disposition slice is done or cancelled, or n has a task and every task on n is settled (`train-task-settled:`, which a
 *   holder's `train-task-failed:` leads to).
 * A slice with a runner request still waiting for its result is left to that run.
 */
export function endedFullSlices(ledger: Ledger, wl: string): EndedFullSlice[] {
	const control = controlOf(ledger, wl);
	const settles = taskSettles(control);
	const tasks = parseTrainTasks(wl, control);
	const disposed = (n: number): string | null => {
		const d = ledger.slice(trainSliceId(wl, n));
		return d !== null && (d.state === "done" || d.state === "cancelled") ? `#${n}'s disposition ${d.id} is ${d.state}` : null;
	};
	const out: EndedFullSlice[] = [];
	const trainWaiting = new Set(testRuns(ledger.entries(wl)).filter((r) => r.results.length === 0).map((r) => r.request.slice));
	for (const s of ledger.slices(wl)) {
		const n = s.state === "open" ? trainSlicePr(s.id, wl) : null;
		if (n === null || s.id === trainSliceId(wl, n) || trainWaiting.has(s.id)) continue;
		const why = disposed(n);
		if (why !== null) out.push({ slice: s.id, workloadId: wl, pr: n, why });
	}
	for (const f of fixBindings(ledger)) {
		if (!fixBinds(ledger, f, wl, f.pr)) continue;
		const on = tasks.filter((t) => t.pr === f.pr);
		const last = on.at(-1);
		const why = disposed(f.pr)
			?? (last !== undefined && on.every((t) => settles.has(t.id)) ? `every task on #${f.pr} is settled (${last.id} ${settles.get(last.id)!.outcome})` : null);
		if (why === null) continue;
		const runs = testRuns(ledger.entries(f.workloadId)).filter((r) => r.request.pr === f.pr);
		const pending = new Set(runs.filter((r) => r.results.length === 0).map((r) => r.request.slice));
		for (const sl of new Set(runs.map((r) => r.request.slice))) {
			const s = ledger.slice(sl);
			if (s?.state === "open" && s.workload_id === f.workloadId && !pending.has(sl) && !out.some((e) => e.slice === sl)) out.push({ slice: sl, workloadId: f.workloadId, pr: f.pr, why });
		}
	}
	return out;
}

/** A result of `verdict` at `sha` may carry to the PR's `head` for task `t`: a green at S, neither H0 nor the head, while the head is not H0. */
function carries(verdict: string, sha: string, t: TrainTask, head: string | null): head is string {
	return verdict === "green" && head !== null && head !== t.head && sha !== t.head && sha !== head;
}

/**
 * The compares `settleTasks` on `facts.train` would read now (PLAN wl-mvpwkpqobyp20w D2): per unsettled task, the carry of its
 * NEWEST runner request, when that request's own result is a green at S that carries to the PR's current head; one row per
 * (pr, S, head). An older green never carries (a later request, pending or not, may be a red at the head), and a newest request
 * with no result or any other result lists nothing. The tick fetches each with `ghCompare` before its settle transaction, so no
 * gh call holds the ledger's lock.
 */
export function carryPairs(ledger: Ledger, facts: Pick<SettleFacts, "train" | "heads">): { pr: number; from: string; to: string }[] {
	const fixes = fixBindings(ledger);
	const out = new Map<string, { pr: number; from: string; to: string }>();
	for (const t of unsettledTasks(ledger, facts.train)) {
		const head = facts.heads.get(t.pr) ?? null;
		const runs = taskRuns(ledger, t, taskOwners(ledger, t, fixes));
		const res = runs.at(-1)?.result;
		if (res && carries(res.verdict, res.sha, t, head)) out.set(`${t.pr} ${res.sha} ${head}`, { pr: t.pr, from: res.sha, to: head });
	}
	return [...out.values()];
}

/**
 * The tick's retry of a PR the train passed over with `train-error: pr <n> …` (a second runner error or refused merge, or a
 * head branch with a live lane; D10, "the tick retries it"): the train is woken this long after its lane exited, doubling with
 * each pass-over of that PR since its newest task settle or its own newest membership entry (Jo's `train:` naming it, or its
 * `train-board:`), up to TRAIN_RETRY_MAX_MS. So a transient error
 * is retried within 15 min, and a PR that keeps failing costs one train launch every 4 h, not one per 5-minute tick.
 */
export const TRAIN_RETRY_BASE_MS = 15 * 60_000;
export const TRAIN_RETRY_MAX_MS = 4 * 3_600_000;

const PASSED_OVER_RE = /^train-error:\s+pr\s+([1-9]\d*)(?:\s|$)/;
const SETTLED_AT_RE = /\bat ([0-9a-f]{40})\b/;
const HEAD_WOKEN_RE = /^train-head-woken: pr ([1-9]\d*) ([0-9a-f]{40})$/;

/**
 * `train-head-woken: pr <n> <sha>`: the tick (MERGE_TRAIN_BY) requested a lane on the train for PR n's head `sha`, once per
 * request, whichever starter served it (`trainRetries`). It is not an acknowledgment: the head stays due, under the pass-over
 * backoff, until the train works it.
 */
export function trainHeadWokenBody(pr: number, sha: string): string {
	return `train-head-woken: pr ${pr} ${sha}`;
}

const TRAIN_HOLD_RE = /^train-hold:\s+pr\s+([1-9]\d*)\s+head\s+([0-9a-f]{40})\s+until\s+(\S+)$/;
const TRAIN_WAKE_RE = /^train-wake: pr ([1-9]\d*) hold (\S+)$/;

/**
 * `train-hold: pr <n> head <sha> until <time|jo>` (PLAN wl-mvfkv7llkp7nk0 § 3): the train's lane read `hold:` from the stakes
 * command for PR n at `sha` and passed it over, its disposition slice left open; `until` is the stakes line's end.
 */
export function trainHoldBody(pr: number, sha: string, until: string): string {
	return `train-hold: pr ${pr} head ${sha} until ${until}`;
}

/** `train-wake: pr <n> hold <entry id>`: the tick (MERGE_TRAIN_BY) requested a lane for that `train-hold:`'s expiry (`expiredHolds`), whichever starter serves it. */
export function trainWakeBody(pr: number, holdId: string): string {
	return `train-wake: pr ${pr} hold ${holdId}`;
}

/**
 * The held PRs of train `wl` whose hold has ended (PLAN wl-mvfkv7llkp7nk0 § 3), each with its `train-hold:` entry. Per PR
 * whose disposition slice is not done or cancelled: the newest `train-hold:` by a holder of the train, when no later entry
 * on the train names that PR (a holder's `train-error:` or `train-hold:`, a `train-task:`, or the tick's own `train-wake:`
 * for that hold) and no question on its slice was raised at or after it. Its end is met when `until` is a time now past,
 * or, for `until jo`, when `stakesOf(pr)` (the tick's current `prStakes`) is no longer a hold until `jo`: normal,
 * production, or a hold whose time is past. A `stakesOf` that cannot answer (null) leaves an `until jo` hold in force.
 */
export function expiredHolds(ledger: Ledger, wl: string, stakesOf: (pr: number) => PrStakes | null = () => null): { pr: number; holdId: string }[] {
	const entries = ledger.entries(wl);
	const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
	const tasks = parseTrainTasks(wl, controlOf(ledger, wl));
	const questions = ledger.questions(wl);
	const now = Date.parse(ledger.now());
	const out: { pr: number; holdId: string }[] = [];
	const prOf = (e: EntryRow, re: RegExp, by: (writer: string) => boolean): number | null => {
		const m = e.kind === "assumption" && by(e.created_by) ? re.exec(e.body.trim()) : null;
		return m ? Number(m[1]) : null;
	};
	const holder = (writer: string) => holders.includes(writer);
	for (const n of trainPrs(entries, ledger.instructions(wl))) {
		const sl = ledger.slice(trainSliceId(wl, n));
		if (sl && (sl.state === "done" || sl.state === "cancelled")) continue;
		const at = entries.findLastIndex((e) => prOf(e, TRAIN_HOLD_RE, holder) === n);
		if (at < 0) continue;
		const hold = entries[at]!;
		const consumed = entries.slice(at + 1).some((e) => {
			if (prOf(e, PASSED_OVER_RE, holder) === n) return true;
			const wake = e.kind === "assumption" && e.created_by === MERGE_TRAIN_BY ? TRAIN_WAKE_RE.exec(e.body.trim()) : null;
			return wake !== null && Number(wake[1]) === n && wake[2] === hold.id;
		});
		if (consumed || tasks.some((t) => t.pr === n && t.createdAt >= hold.created_at)) continue;
		if (questions.some((q) => q.slice_id === trainSliceId(wl, n) && q.created_at >= hold.created_at)) continue;
		const until = TRAIN_HOLD_RE.exec(hold.body.trim())![3]!;
		let met: boolean;
		if (until === "jo") {
			const s = stakesOf(n);
			met = s !== null && !(s.stakes === "hold" && (s.until === "jo" || now < Date.parse(s.until)));
		} else {
			const end = Date.parse(until);
			met = !Number.isNaN(end) && now >= end;
		}
		if (met) out.push({ pr: n, holdId: hold.id });
	}
	return out;
}

/** A released train's unfinished PRs the tick wakes it for (`trainRetries`). */
export interface TrainRetries {
	/** PRs passed over with `train-error: pr <n>` whose retry wait has passed, with how many pass-overs the wait counted. */
	passedOver: { pr: number; count: number }[];
	/** PRs back from their owner whose current head the train has not worked, with how many times the tick woke it for that head. */
	untested: { pr: number; sha: string; woken: number }[];
}

/**
 * D13 (PLAN wl-mvq4edbaf13vnk): the owner workload of PR `pr` on train `wl`: the workload its `train-board:` names, or, for a PR
 * only Jo's `train:` names, the workload whose lane branch `wl/<id>` is the PR's head ref (`headRef`, the tick's `gh pr view`);
 * null when neither names an existing workload.
 */
export function prOwner(ledger: Ledger, wl: string, pr: number, headRef: string | null): string | null {
	const board = trainBindings(ledger.entries(wl), ledger.instructions(wl)).findLast((b) => b.source === "board" && b.prs.includes(pr))?.board ?? null;
	const id = board?.workload ?? (headRef === null ? null : (/^wl\/(wl-[a-z0-9]+)$/.exec(headRef)?.[1] ?? null));
	return id !== null && ledger.workload(id) ? id : null;
}

/**
 * D13: why owner workload `owner` is busy, or null. Busy while it holds a live lane lease (`heldLive`: a lease past its expiry
 * is not live, so a dead owner never holds the train), or while every one of its open or paused slices (at least one) carries a
 * `test-requested:` with no settle yet: its full-suite run is queued or running (`testRuns`; the runner's reap settles a dead one).
 */
export function ownerBusy(ledger: Ledger, owner: string): string | null {
	const w = ledger.workload(owner);
	if (!w || w.status !== "open") return null;
	const now = ledger.now();
	if (heldLive(w, now)) return `${owner} is held live by ${w.holder}${w.holder_lease_until === null ? "" : ` until ${w.holder_lease_until}`}`;
	const open = ledger.slices(owner).filter((s) => s.state === "open" || s.state === "paused");
	if (open.length === 0) return null;
	const unsettled = testRuns(ledger.entries(owner)).filter((r) => r.results.length === 0);
	const waiting = open.map((s) => unsettled.findLast((r) => r.request.slice === s.id));
	if (waiting.some((r) => r === undefined)) return null;
	return `${owner}'s only open work waits on its test run${waiting.length > 1 ? "s" : ""} ${waiting.map((r) => r!.request.runId).join(", ")}`;
}

/** D13: a per-PR wake reason the tick held back this pass because the PR's owner is busy. */
export interface WakeDeferral {
	pr: number;
	owner: string;
	busy: string;
	reasons: string[];
}

/**
 * Why the tick wakes train `wl` (D10 step 1), or empty when nothing is actionable: a `train:` entry (the open, or Jo's append),
 * a `train-board:` (`#n boarded`, PLAN wl-mvbjiettjrfpxc D3)
 * or a task settle written after the train's last ready lane exit (`lastReadyExit`), a PR no lane has worked since one exited
 * (`#<n> not yet worked`: no disposition slice, or a slice the tick added that `trainLaneWorked` says no lane of the train has
 * worked), a PR among `mergedDeps` (PRs whose dependency the tick saw merge on GitHub since the last ready exit), Jo's answer to
 * (or withdrawal of) the tick's own alert question (D9) after the last ready exit: no lane raised that question, so no resume
 * follows it, and Jo's answer to (or withdrawal of) a question the train's lane raised whose instruction no ready lane's first
 * prompt carried yet (`consumedByReady`, PLAN wl-mvpsrr4tr0p1xc D2). A lane that never got ready swallows nothing: the
 * cutoffs read `lastReadyExit`, so the work that woke it wakes the train again (bounded by `trainLaunchFailures`).
 * After a lane exit, also every PR `trainRetries` lists: a passed-over PR whose retry is due, and a head the train has not seen;
 * a PR in `heldPassOvers` (passed over for main's protection while its episode is open, PLAN wl-mvbjiettjrfpxc D6, or for a
 * stopped landing, PLAN wl-mvq4edbaf13vnk D9) waits instead;
 * and every held PR whose hold has ended (`expiredHolds`, `hold-expired`; `stakesOf` is the tick's current `prStakes`).
 * D13 (PLAN wl-mvq4edbaf13vnk), with `owners`: a per-PR reason (`#n boarded`, not yet worked, a passed-over retry, an untested
 * head, `hold-expired`, a merged dependency, a settled task on that PR) is deferred while the PR's owner (`prOwner`, the head
 * refs from the tick's views) is busy (`ownerBusy`); each deferred PR goes to `owners.defer` once. Deferred, not dropped: the
 * same cutoffs give the reason again on the first pass after the owner is free. Train-wide reasons (`train:` entries, alerts,
 * answered questions) are never deferred.
 */
export function actionable(
	ledger: Ledger, wl: string, mergedDeps: readonly number[] = [], heads: ReadonlyMap<number, string> = new Map(), heldPassOvers: ReadonlySet<number> = new Set(),
	stakesOf: (pr: number) => PrStakes | null = () => null,
	owners: { headRefs: ReadonlyMap<number, string>; defer: (d: WakeDeferral) => void } | null = null,
): string[] {
	const control = controlOf(ledger, wl);
	const exit = control.filter((c) => c.prefix === "lane-exit").at(-1) ?? null;
	const lastExit = lastReadyExit(control);
	const after = (at: string) => lastExit === null || at > lastExit;
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const questions = ledger.questions(wl);
	const out: { pr: number | null; text: string }[] = [];
	for (const b of trainBindings(entries, instructions)) {
		if (!after(b.createdAt)) continue;
		out.push(b.source === "board" ? { pr: b.prs[0]!, text: `#${b.prs[0]} boarded` } : { pr: null, text: `train: ${b.prs.map((n) => `#${n}`).join(" ")} (${b.entryId})` });
	}
	const tasks = parseTrainTasks(wl, control);
	const settles = taskSettles(control);
	for (const s of settles.values()) {
		const pr = tasks.find((t) => t.id === s.taskId)?.pr ?? null;
		if (after(s.createdAt)) out.push({ pr, text: `task ${s.taskId} on #${pr ?? "?"} settled ${s.outcome}` });
	}
	const prs = trainPrs(entries, instructions);
	if (exit !== null) {
		const slices = new Map(ledger.slices(wl).map((s) => [s.id, s]));
		for (const n of prs) {
			const sl = slices.get(trainSliceId(wl, n));
			if (!sl || (sl.created_by === MERGE_TRAIN_BY && !trainLaneWorked(wl, sl, control, entries, questions))) out.push({ pr: n, text: `#${n} not yet worked` });
		}
		const r = trainRetries(ledger, wl, heads);
		for (const p of r.passedOver) if (!heldPassOvers.has(p.pr)) out.push({ pr: p.pr, text: `#${p.pr} passed over ${p.count}x (train-error:), retry due` });
		for (const h of r.untested) out.push({ pr: h.pr, text: `#${h.pr} head ${h.sha} untested by the train${h.woken > 0 ? ` after ${h.woken} wake(s), retry due` : ""}` });
		for (const h of expiredHolds(ledger, wl, stakesOf)) out.push({ pr: h.pr, text: `#${h.pr} hold-expired (${h.holdId})` });
	}
	for (const n of mergedDeps) if (prs.includes(n)) out.push({ pr: n, text: `#${n}'s dependency merged` });
	for (const q of questions) {
		const n = q.created_by === MERGE_TRAIN_BY && q.state !== "open" ? trainSlicePr(q.slice_id, wl) : null;
		if (n !== null && after(q.changed_at)) out.push({ pr: null, text: `alert ${q.id} on #${n} ${q.state}` });
	}
	const lane = trainLanePattern(wl);
	for (const q of questions) {
		if (q.state === "open" || !lane.test(q.created_by) || q.resolved_by === null) continue;
		const ins = instructions.find((i) => i.id === q.resolved_by);
		if (ins && !consumedByReady(control, ins.created_at)) out.push({ pr: null, text: `question ${q.id} ${q.state}, not yet resumed` });
	}
	if (owners === null) return out.map((r) => r.text);
	const busy = new Map<number, { owner: string; busy: string } | null>();
	const busyOf = (pr: number) => {
		if (!busy.has(pr)) {
			const owner = prOwner(ledger, wl, pr, owners.headRefs.get(pr) ?? null);
			const why = owner === null ? null : ownerBusy(ledger, owner);
			busy.set(pr, owner !== null && why !== null ? { owner, busy: why } : null);
		}
		return busy.get(pr)!;
	};
	const deferred = new Map<number, WakeDeferral>();
	const wake: string[] = [];
	for (const r of out) {
		const b = r.pr === null ? null : busyOf(r.pr);
		if (b === null) {
			wake.push(r.text);
			continue;
		}
		const d = deferred.get(r.pr!) ?? { pr: r.pr!, owner: b.owner, busy: b.busy, reasons: [] };
		d.reasons.push(r.text);
		deferred.set(r.pr!, d);
	}
	for (const d of deferred.values()) owners.defer(d);
	return wake;
}

/**
 * D2 (PLAN wl-mvpsrr4tr0p1xc): the lanes that never got their first prompt: a runner launch (a `launch:` attempt whose cause is
 * not `interactive`) with no `lane-ready:`. A lane Jo ran by hand (`cause interactive`) or one no `launch:` names had no
 * readiness step, so it is never one of them.
 */
function neverReadyLanes(control: readonly ControlEntry[]): Set<string> {
	const ready = new Set(control.flatMap((c) => (c.prefix === "lane-ready" && c.laneId !== null ? [c.laneId] : [])));
	return new Set(attempts(control).flatMap((a) => (a.cause?.kind !== "interactive" && !ready.has(a.laneId) ? [a.laneId] : [])));
}

/**
 * D2 (PLAN wl-mvpsrr4tr0p1xc): the time of the newest `lane-exit:` of a lane that got its first prompt (not `neverReadyLanes`),
 * or null. The train's "since the last lane exit" cutoffs read it, so a launch that never got ready swallows no work.
 */
export function lastReadyExit(control: readonly ControlEntry[]): string | null {
	const never = neverReadyLanes(control);
	return control.filter((c) => c.prefix === "lane-exit" && c.laneId !== null && !never.has(c.laneId)).at(-1)?.createdAt ?? null;
}

/** The `lane-exit:` outcomes by which a ready lane ended its pass by its own word (D2's `#<n> not yet worked` rule). */
const OWN_WORD_ENDS: readonly string[] = ["parked", "released", "completed"];

/**
 * D2 (PLAN wl-mvpsrr4tr0p1xc): whether train `wl`'s own lanes worked slice `sl` (one the tick added to carry an alert) since it
 * was added: one of the train's lanes (`lane-<wl without wl->-<n>`; machinery writers do not count) wrote an entry or a question
 * on it or last changed its state, or a lane that got its first prompt (not `neverReadyLanes`) ended its pass by its own word
 * (its `released-open:`, or a `lane-exit:` outcome parked, released or completed). Readiness alone, a crash, or an `open-work`
 * exit with no `released-open:` is no work: the PR stays `not yet worked`.
 */
function trainLaneWorked(wl: string, sl: SliceRow, control: readonly ControlEntry[], entries: readonly EntryRow[], questions: readonly QuestionRow[]): boolean {
	const since = sl.created_at;
	const lane = trainLanePattern(wl);
	if (lane.test(sl.changed_by) && sl.changed_at >= since) return true;
	if (entries.some((e) => e.slice_id === sl.id && lane.test(e.created_by) && e.created_at >= since)) return true;
	if (questions.some((q) => q.slice_id === sl.id && lane.test(q.created_by) && q.created_at >= since)) return true;
	const never = neverReadyLanes(control);
	return control.some((c) => {
		if (c.laneId === null || never.has(c.laneId) || c.createdAt < since) return false;
		return c.prefix === "released-open" || (c.prefix === "lane-exit" && OWN_WORD_ENDS.includes(laneExit([c], c.laneId)?.outcome ?? ""));
	});
}

/** The ids of train `wl`'s own lanes, `lane-<wl without wl->-<n>` (`reserveLane`'s numbering); machinery writers never match. */
function trainLanePattern(wl: string): RegExp {
	return new RegExp(`^lane-${wl.replace(/^wl-/, "")}-[1-9]\\d*$`);
}

/**
 * What wakes released train `wl` for its unfinished PRs (D10 "the tick retries it"; empty while no lane has exited). Only a
 * PR that is not terminal, has no unsettled task (its owner is on it) and no open question on its slice (Jo decides) counts:
 * - passed over: the train wrote `train-error: pr <n> …` (a holder's entry) before its last lane exit, and TRAIN_RETRY_BASE_MS,
 *   doubled per pass-over since the PR's newest settle, its newest `train-hold:`, or its own newest membership entry (Jo's
 *   `train:` naming it, or its `train-board:`; another PR's entry resets nothing, review wl-mvbjiettjrfpxc r1 #1), has passed since that exit;
 * - untested: the PR came back from its owner (a settled task) and its head in `heads` (the tick's `gh pr view`) is one the
 *   train has not worked: no train run requested at it, not a task's head, not the sha a settle names, and no `train-error:
 *   pr <n>` from a holder since the tick's newest `train-head-woken:` for it. A wake is not the work: a head woken (a lane
 *   requested for it) k times is due again once TRAIN_RETRY_BASE_MS × 2^(k-1), capped at TRAIN_RETRY_MAX_MS, has passed since
 *   the newest of that wake and the train's last lane end after it (`lane-exit:` or `launch-failed:`), so a request served late
 *   is measured from that lane's end, a launch that died before the work is retried, and never every tick. While a lane holds
 *   the train live the tick wakes nothing.
 * "Before" and "since" are ledger order (entries in the order written), so rows written in one millisecond still order.
 */
export function trainRetries(ledger: Ledger, wl: string, heads: ReadonlyMap<number, string>): TrainRetries {
	const out: TrainRetries = { passedOver: [], untested: [] };
	const entries = ledger.entries(wl);
	const control = controlOf(ledger, wl);
	const exit = control.filter((c) => c.prefix === "lane-exit").at(-1);
	if (!exit) return out;
	const now = Date.parse(ledger.now());
	const order = new Map(entries.map((e, i) => [e.id, i]));
	const at = (id: string) => order.get(id) ?? -1;
	const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
	const passed: { pr: number; i: number }[] = [];
	// A holder's `train-hold:` (PLAN wl-mvfkv7llkp7nk0 § 3): its expiry (`expiredHolds`) wakes the PR, so pass-overs before it no longer count.
	const heldAt = new Map<number, number>();
	const woken = new Map<string, { i: number; at: string }[]>();
	entries.forEach((e, i) => {
		if (e.kind !== "assumption") return;
		const p = holders.includes(e.created_by) ? PASSED_OVER_RE.exec(e.body.trim()) : null;
		if (p) passed.push({ pr: Number(p[1]), i });
		const held = holders.includes(e.created_by) ? TRAIN_HOLD_RE.exec(e.body.trim()) : null;
		if (held) heldAt.set(Number(held[1]), i);
		const h = e.created_by === MERGE_TRAIN_BY ? HEAD_WOKEN_RE.exec(e.body.trim()) : null;
		if (h) woken.set(`${h[1]} ${h[2]}`, [...(woken.get(`${h[1]} ${h[2]}`) ?? []), { i, at: e.created_at }]);
	});
	const lastEnd = control.filter((c) => c.prefix === "lane-exit" || c.prefix === "launch-failed").at(-1)!;
	const trainRuns = testRuns(entries);
	const instructions = ledger.instructions(wl);
	const bindings = trainBindings(entries, instructions);
	const tasks = parseTrainTasks(wl, control);
	const settles = taskSettles(control);
	const questions = ledger.questions(wl);
	for (const n of trainPrs(entries, instructions)) {
		const sl = ledger.slice(trainSliceId(wl, n));
		if (!sl || sl.workload_id !== wl || sl.state === "done" || sl.state === "cancelled") continue;
		if (questions.some((q) => q.slice_id === sl.id && q.state === "open")) continue;
		const mine = tasks.filter((t) => t.pr === n);
		if (mine.some((t) => !settles.has(t.id))) continue;
		const settled = mine.flatMap((t) => settles.get(t.id) ?? []);
		const joined = Math.max(-1, ...bindings.filter((b) => b.prs.includes(n)).map((b) => at(b.entryId)));
		const since = Math.max(joined, heldAt.get(n) ?? -1, ...settled.map((s) => at(s.entryId)));
		const over = passed.filter((p) => p.pr === n && p.i > since);
		if (over.length > 0 && over.at(-1)!.i < at(exit.id)) {
			const wait = Math.min(TRAIN_RETRY_BASE_MS * 2 ** (over.length - 1), TRAIN_RETRY_MAX_MS);
			if (now - Date.parse(exit.createdAt) >= wait) out.passedOver.push({ pr: n, count: over.length });
		}
		const head = heads.get(n);
		if (head === undefined || settled.length === 0) continue;
		const seen = new Set([
			...trainRuns.filter((r) => r.request.pr === n).map((r) => r.request.sha), ...mine.map((t) => t.head),
			...settled.flatMap((s) => SETTLED_AT_RE.exec(s.evidence)?.[1] ?? []),
		]);
		if (seen.has(head)) continue;
		const wakes = woken.get(`${n} ${head}`) ?? [];
		const last = wakes.at(-1);
		if (last === undefined) {
			out.untested.push({ pr: n, sha: head, woken: 0 });
			continue;
		}
		// The train passed the PR over since the wake: that pass-over's retry (above) owns it now.
		if (passed.some((p) => p.pr === n && p.i > last.i)) continue;
		const from = at(lastEnd.id) > last.i ? lastEnd.createdAt : last.at;
		const wait = Math.min(TRAIN_RETRY_BASE_MS * 2 ** (wakes.length - 1), TRAIN_RETRY_MAX_MS);
		if (now - Date.parse(from) >= wait) out.untested.push({ pr: n, sha: head, woken: wakes.length });
	}
	return out;
}

/** One delivery the tick owes (D10 step 2): launch an autonomous owner that is not live, or open the fix workload for owner none. */
export type OwnerDelivery = { kind: "launch"; task: TrainTask; owner: string } | { kind: "fix"; task: TrainTask };

/**
 * The deliveries owed now across every open train (D7, D10 step 2). An unsettled task whose owners (its D1 owner and any valid
 * fix workload) include an open one goes to each that is autonomous and not held live; a live lane gets the aside
 * (`pushTrainTasks`) and a user-driven one its by-hand session, so neither is launched. A task with no open owner is `fix`.
 */
export function ownerDeliveries(ledger: Ledger): OwnerDelivery[] {
	const now = ledger.now();
	const fixes = fixBindings(ledger);
	const out: OwnerDelivery[] = [];
	for (const train of openTrains(ledger)) {
		for (const t of unsettledTasks(ledger, train)) {
			const open = taskOwners(ledger, t, fixes).flatMap((o) => {
				const w = ledger.workload(o);
				return w && w.status === "open" ? [w] : [];
			});
			if (open.length === 0) out.push({ kind: "fix", task: t });
			for (const w of open) if (w.mode === "autonomous" && !heldLive(w, now)) out.push({ kind: "launch", task: t, owner: w.id });
		}
	}
	return out;
}

/** The owner's open full-suite slice for PR `pr`: the slice of its newest test request on that PR that is still open; else null. */
function openFullSlice(ledger: Ledger, wl: string, pr: number): string | null {
	const recs = testRuns(ledger.entries(wl)).filter((r) => r.request.pr === pr);
	for (let i = recs.length - 1; i >= 0; i--) {
		const s = ledger.slice(recs[i]!.request.slice);
		if (s && s.workload_id === wl && s.state === "open") return s.id;
	}
	return null;
}

/** The unsettled tasks workload `wl` owns (D7: its D1 tasks, and those of a PR it is the fix workload for), oldest train first. */
export function ownerTasks(ledger: Ledger, wl: string): OwnerTrainTask[] {
	const fixes = fixBindings(ledger);
	return openTrains(ledger).flatMap((train) => unsettledTasks(ledger, train)
		.filter((t) => taskOwners(ledger, t, fixes).includes(wl))
		.map((t) => ({ id: t.id, train, pr: t.pr, attempt: t.attempt, kind: t.kind, head: t.head, detail: t.detail, slice: openFullSlice(ledger, wl, t.pr) })));
}

/** When a workload owned a task (D9 F16): from t0 to the settle, or open-ended while unsettled. */
export interface TaskWindow {
	taskId: string;
	/** The task's PR: only that PR's runner failures are the task's to count. */
	pr: number;
	from: string;
	to: string | null;
	/** The red run the settle counted (its evidence `run <id> red …`), or null. */
	counted: string | null;
}

const COUNTED_RE = /^run (tr-[a-z0-9]+) red /;

/** Every task window on the open trains, by owning workload. */
export function trainTaskWindows(ledger: Ledger): Map<string, TaskWindow[]> {
	const fixes = fixBindings(ledger);
	const out = new Map<string, TaskWindow[]>();
	for (const train of openTrains(ledger)) {
		const control = controlOf(ledger, train);
		const settles = taskSettles(control);
		for (const t of parseTrainTasks(train, control)) {
			const s = settles.get(t.id);
			const w = { taskId: t.id, pr: t.pr, from: t.createdAt, to: s?.createdAt ?? null, counted: s ? (COUNTED_RE.exec(s.evidence)?.[1] ?? null) : null };
			for (const o of taskOwners(ledger, t, fixes)) out.set(o, [...(out.get(o) ?? []), w]);
		}
	}
	return out;
}

/** A fix workload's brief (D8): the train, the PR, its head branch and the task, with D7's rules. */
export function trainFixBrief(f: TrainFix, headBranch: string, taskId: string): string {
	return [
		`merge-train fix: PR #${f.pr} on ${f.repo} (head branch ${headBranch}), returned by merge train ${f.train} as ${taskId}; the PR's own workload is missing or closed, so this workload owns it.`,
		"",
		`Your first prompt lists the PR's unsettled train task with its detail; a later attempt arrives as an aside. Fix it on ${headBranch}: ` +
			`a worktree on a new branch tracking origin/${headBranch}, main brought in with \`git merge --no-ff origin/main\`, never a rebase and never a force-push.`,
		`Pass your declared artifact, push to ${headBranch}, then \`${LANE_FULL_TEST_TOOL} { pr: ${f.pr} }\` with no slice the first time and every rerun on the slice it creates. ` +
			"A green at the new head settles the task fixed; a red settles it failed.",
		`When you cannot fix it: \`${LANE_RECORD_ENTRY_TOOL}\` \`${TRAIN_TASK_FAILED_PREFIX} <task id> <why>\`, then release. When the task settles, write done-because naming the task and its outcome, and release.`,
	].join("\n");
}

export interface FixInput {
	task: TrainTask;
	/** The train's repository, `owner/repo`. */
	repo: string;
	/** The train's `repo:` checkout, the fix workload's `repo:`. */
	checkout: string;
	/** The tick's `gh pr view` of the PR: its head branch is the fix workload's `push-dest:`, so row 8 lets its push there through. */
	view: TaskView;
	/** D1's stakes for the PR. */
	stakes: Stakes;
}

/**
 * The fork PR `view` is on, `owner/repo`, when its head is not on the train's repository `repo` (a cross-repository PR, or a
 * head repository GitHub does not name); null for a same-repository head. No workload can fix such a PR: its `push-dest:` and
 * row 8 name only a branch on the checkout's origin, and the test runner never runs a fork head (`prAdmissible`).
 */
export function forkOf(view: TaskView, repo: string): string | null {
	const head = view.headRepository && view.headRepositoryOwner ? `${view.headRepositoryOwner.login}/${view.headRepository.name}` : null;
	if (!view.isCrossRepository && head?.toLowerCase() === repo.toLowerCase()) return null;
	return head ?? "an unknown repository";
}

/**
 * The fix workload for task `input.task` with owner none (D8), in one transaction: at most one open per (repo, PR). An open
 * workload carrying `train-fix: repo <repo> pr <n> …` is reused (given this train's binding when it lacks it); else one is
 * opened autonomous at `stakes`, as MERGE_TRAIN_BY, with the brief, `repo:`, `done:`, the `train-fix:` binding naming the
 * `train:` or `train-board:` entry that lists the PR (`trainBindings`), `push-dest:` at the PR's head branch and `launch-requested: by merge-train`.
 * Throws when no membership entry on the train lists the PR (a binding is only ever derived from Jo's train word or the tick's board),
 * and on a fork's PR (`forkOf`): its fix goes to Jo instead (`forkTaskAlert`).
 */
export function openTrainFix(ledger: Ledger, input: FixInput): { workloadId: string; opened: boolean } {
	const { task, view } = input;
	const fork = forkOf(view, input.repo);
	if (fork !== null) throw new Error(`#${task.pr}'s head is on the fork ${fork}, which no fix workload can push to; no fix workload is opened`);
	return ledger.write(() => {
		const entry = trainBindings(ledger.entries(task.train), ledger.instructions(task.train)).find((b) => b.prs.includes(task.pr));
		if (!entry) throw new Error(`#${task.pr} is on no train: or train-board: entry of ${task.train}; no fix workload is opened`);
		const fix: TrainFix = { repo: input.repo, pr: task.pr, train: task.train, trainEntry: entry.entryId };
		const fixes = fixBindings(ledger);
		const reuse = fixes.find((f) => f.repo.toLowerCase() === fix.repo.toLowerCase() && f.pr === fix.pr);
		if (reuse) {
			if (!fixes.some((f) => f.workloadId === reuse.workloadId && f.train === fix.train && f.trainEntry === fix.trainEntry)) {
				ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: reuse.workloadId, kind: "assumption", body: trainFixBody(fix) });
			}
			return { workloadId: reuse.workloadId, opened: false };
		}
		const wl = newId("workload");
		ledger.openWorkload({ by: MERGE_TRAIN_BY, id: wl, brief: trainFixBrief(fix, view.headRefName, task.id), stakes: input.stakes, mode: "autonomous" });
		for (const body of [
			`repo: ${input.checkout}`,
			doneBody(TRAIN_FIX_DONE),
			trainFixBody(fix),
			pushDestBody({ remote: "origin", branch: view.headRefName, sha: task.head }),
			launchRequestedBody(MERGE_TRAIN_BY, ledger.now(), `train fix #${task.pr} on ${task.train}`),
		]) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body });
		return { workloadId: wl, opened: true };
	});
}

/** The question a fork's ownerless task raises (`forkTaskAlert`): the PR, the fork, what each answer does, then the task's detail. */
export function trainForkQuestionBody(t: TrainTask, fork: string, headBranch: string): string {
	return [
		`merge train ${t.train}: #${t.pr} needs a fix no workload can make: task ${t.id} (attempt ${t.attempt}, ${t.kind}) has no owner, and the ` +
			`PR's head is ${headBranch} on the fork ${fork}, which no workload can push to and the test runner never runs. ` +
			`retry: the train works #${t.pr} again at its current head (fix it on the fork, or have its author fix it, first); skip cancels its train slices; stop holds the train.`,
		"",
		t.detail,
	].join("\n");
}

/**
 * Fail closed on a fork (D8 owner none, D9): task `t` has no owner and its PR's head is on the fork `forkOf` names, so instead of
 * a fix workload that could never push there, the tick settles the task failed and raises D9's retry / skip / stop alert on the
 * PR's slice, in one transaction, as MERGE_TRAIN_BY. While that question is open the train does not return the PR again
 * (`recordTrainTask`). Null when the task is settled already or the view is no fork.
 */
export function forkTaskAlert(ledger: Ledger, t: TrainTask, view: TaskView, repo: string): string | null {
	const fork = forkOf(view, repo);
	if (fork === null) return null;
	return ledger.write(() => {
		if (!unsettledTasks(ledger, t.train).some((x) => x.id === t.id)) return null;
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: t.train, kind: "assumption", body: trainTaskSettledBody(t.id, "failed", `fork ${fork}: no workload can push to ${view.headRefName}`) });
		const sl = ensurePrSlice(ledger, t.train, t.pr);
		if (openRetryQuestion(ledger, t.train, t.pr)) return null;
		// PLAN wl-mvfkv7llkp7nk0 § 1: every raise goes through the standing rulings; none covers a train question.
		const body = trainForkQuestionBody(t, fork, view.headRefName);
		return raisedId(askJo(ledger, { by: MERGE_TRAIN_BY, workloadId: t.train, sliceId: sl, body, options: [...TRAIN_RETRY_OPTIONS] }, { asker: "train" }), `the fork question of PR #${t.pr}`);
	});
}

/** PR `pr`'s disposition slice on train `wl`, added as the tick when the lane never added it. */
function ensurePrSlice(ledger: Ledger, wl: string, pr: number): string {
	const sl = trainSliceId(wl, pr);
	if (!ledger.slice(sl)) {
		ledger.addSlice({ by: MERGE_TRAIN_BY, workloadId: wl, id: sl, task: `#${pr} on merge train ${wl}`, doneCondition: `#${pr} is terminal on the train`, inputs: `PR #${pr}` });
	}
	return sl;
}

/** The open retry / skip / stop alert on PR `pr`'s slice of train `wl` (D9), or null. */
function openRetryQuestion(ledger: Ledger, wl: string, pr: number): QuestionRow | null {
	const sl = trainSliceId(wl, pr);
	return ledger.questions(wl).find((q) => q.slice_id === sl && q.state === "open" && (JSON.parse(q.options) as string[]).includes("retry")) ?? null;
}

// ---- part 3: what Jo hears, and the re-send (rev 17.1 D9-D10) ------------------------------------

/** Where every train alert is filed (D9): an issue on Jo's issues repository. */
export const TRAIN_ALERT_REPO = "thewolff/jo-issues";
/** The label every issue the train files carries (Jo's in-mv93i1qi9mypkw): the issues intake skips it, and no re-send removes it. */
export const TRAIN_ALERT_LABEL = "as2-train";
/** Who a re-send mentions (D9's ladder). */
export const TRAIN_ALERT_MENTION = "@thewolff";
/** The options of the alert the tick raises when attempt 2 settled failed (D9): `retry` grants two more attempts (`nextAttempt`). */
export const TRAIN_RETRY_OPTIONS: readonly string[] = ["retry", "skip", "stop"];
/**
 * The send ladder (D9 F14): level 1 is the issue, at raise; levels 2 and 3 re-send it louder this long after level 1 was sent,
 * with these labels added beside `as2-train` (a comment mentioning Jo, a macOS notification with sound, a LOUD needs-you line).
 * Nothing is sent after level 3.
 */
export const TRAIN_ALERT_LADDER: readonly { level: number; afterMs: number; labels: readonly string[] }[] = [
	{ level: 1, afterMs: 0, labels: [] },
	{ level: 2, afterMs: 4 * 3_600_000, labels: ["loud"] },
	{ level: 3, afterMs: 8 * 3_600_000, labels: ["loud", "critical"] },
];

/** The marker an alert's issue body (level 1) or comment (levels 2, 3) carries, so a retried send finds it before creating another. */
export function trainAlertMarker(q: string, level: number): string {
	return `<!-- train-alert ${q} level ${level} -->`;
}

/** A step of one send (D9): `sending` before the effects, `notified` after the notification, `sent` after them all (with the issue's url). */
export type AlertStep = "sending" | "notified" | "sent";

/** `train-alert: <q> level <n> sending|notified|sent [<issue url>]`, the tick's (MERGE_TRAIN_BY) record of a send. */
export function trainAlertBody(q: string, level: number, step: AlertStep, url?: string): string {
	return `train-alert: ${q} level ${level} ${step}${url ? ` ${url}` : ""}`;
}

/** `train-alert: <q> acked <why>` (Jo closed the issue: no more re-sends) or `train-alert: <q> closed <why>` (the tick closed it after Jo's answer). */
export function trainAlertEndBody(q: string, end: "acked" | "closed", why: string): string {
	return `train-alert: ${q} ${end} ${why.replace(/\s+/g, " ").trim()}`;
}

const ALERT_RE = /^(q-[a-z0-9]+) (?:level ([1-9]) (sending|notified|sent)(?: (\S+))?|(acked|closed)(?: ([\s\S]*))?)$/;

/** What the ledger holds about one alert's sends: per level, when `sending` and `sent` were written, whether it notified; the issue; the ends. */
export interface AlertRecord {
	q: string;
	sending: Map<number, string>;
	sent: Map<number, string>;
	notified: Set<number>;
	/** The issue level 1 created or found. */
	url: string | null;
	acked: boolean;
	closed: boolean;
}

/** Every alert's record among a train's control entries (`train-alert:`, valid only from MERGE_TRAIN_BY), by question id. */
export function trainAlertRecords(control: readonly ControlEntry[]): Map<string, AlertRecord> {
	const out = new Map<string, AlertRecord>();
	for (const c of control) {
		const m = c.prefix === "train-alert" ? ALERT_RE.exec(c.rest) : null;
		if (!m) continue;
		const r = out.get(m[1]!) ?? { q: m[1]!, sending: new Map(), sent: new Map(), notified: new Set<number>(), url: null, acked: false, closed: false };
		out.set(r.q, r);
		if (m[5] === "acked") r.acked = true;
		else if (m[5] === "closed") r.closed = true;
		else {
			const level = Number(m[2]);
			if (m[3] === "notified") r.notified.add(level);
			else if (m[3] === "sending") { if (!r.sending.has(level)) r.sending.set(level, c.createdAt); }
			else if (!r.sent.has(level)) {
				r.sent.set(level, c.createdAt);
				if (level === 1 && m[4]) r.url = m[4];
			}
		}
	}
	return out;
}

/** The loudest level the tick has begun sending for question `q` (0 when none): 2 and 3 make its needs-you line LOUD (D9). */
export function trainAlertLevel(control: readonly ControlEntry[], q: string): number {
	const r = trainAlertRecords(control).get(q);
	return r ? Math.max(0, ...r.sending.keys()) : 0;
}

/** A train question as an alert (D9): every question on one of the train's PR slices is one of Jo's two triggers. */
export interface TrainAlert {
	q: QuestionRow;
	pr: number;
	options: string[];
	/** `failed twice` (the tick's retry / skip / stop), `production merge` (the lane's merged / skip / stop) or `launch limit` (the tick's relaunch / stop, D4). */
	reason: string;
	record: AlertRecord;
}

export function trainAlertReason(options: readonly string[]): string {
	return options.includes("retry") ? "failed twice" : options.includes("merged") ? "production merge" : options.includes("relaunch") ? "launch limit" : "question";
}

/**
 * What the tick owes an alert now: send ladder level `level`, or close the issue of an alert Jo answered or withdrew. A close
 * whose record has no url (level 1 `sending` with no `sent`: the issue may have been filed before a crash) finds the issue by
 * its level 1 marker first.
 */
export type AlertAction = { kind: "send"; alert: TrainAlert; level: number } | { kind: "close"; alert: TrainAlert };

/**
 * The alert sends and closes owed on train `wl` at `now` (D9). An open question: a level whose `sending` has no `sent` is
 * finished first (a crash between them); else level 1 when nothing was sent; else the next level once its `afterMs` has passed
 * since level 1 was sent, until level 3. An acknowledged alert (Jo closed its issue, `acked`) gets nothing more. A question
 * answered or withdrawn (the settle, F13) gets its issue closed once, including one whose level 1 send was begun and not
 * finished (its issue may exist with no url recorded); one settled before any send gets nothing.
 */
export function trainAlertActions(ledger: Ledger, wl: string, now: string): AlertAction[] {
	const records = trainAlertRecords(controlOf(ledger, wl));
	const out: AlertAction[] = [];
	for (const q of ledger.questions(wl)) {
		const pr = trainSlicePr(q.slice_id, wl);
		if (pr === null) continue;
		const options = JSON.parse(q.options) as string[];
		const record = records.get(q.id) ?? { q: q.id, sending: new Map(), sent: new Map(), notified: new Set<number>(), url: null, acked: false, closed: false };
		const alert = { q, pr, options, reason: trainAlertReason(options), record };
		if (q.state !== "open") {
			const begun = record.url !== null || (record.sending.has(1) && !record.sent.has(1));
			if (begun && !record.closed && !record.acked) out.push({ kind: "close", alert });
			continue;
		}
		if (record.acked) continue;
		const unfinished = [...record.sending.keys()].filter((l) => !record.sent.has(l)).sort((a, b) => a - b)[0];
		if (unfinished !== undefined) {
			out.push({ kind: "send", alert, level: unfinished });
			continue;
		}
		const top = Math.max(0, ...record.sent.keys());
		const next = TRAIN_ALERT_LADDER.find((s) => s.level === top + 1);
		if (!next) continue;
		const first = record.sent.get(1);
		if (next.level === 1 || (first !== undefined && Date.parse(now) - Date.parse(first) >= next.afterMs)) out.push({ kind: "send", alert, level: next.level });
	}
	return out;
}

/** A PR whose attempt 2 settled failed with no `retry` from Jo since (D8, D9), and no alert raised for that task yet. */
export interface TwiceFailed {
	pr: number;
	task: TrainTask;
	settle: TaskSettle;
}

/** The PRs on train `wl` owed the failed-twice alert now: the newest task settled failed at the last attempt, the PR's slice not terminal. */
export function twiceFailed(ledger: Ledger, wl: string): TwiceFailed[] {
	const control = controlOf(ledger, wl);
	const settles = taskSettles(control);
	const tasks = parseTrainTasks(wl, control);
	const questions = ledger.questions(wl);
	const out: TwiceFailed[] = [];
	for (const pr of trainPrs(ledger.entries(wl), ledger.instructions(wl))) {
		const task = tasks.filter((t) => t.pr === pr).at(-1);
		const settle = task ? settles.get(task.id) : undefined;
		if (!task || settle?.outcome !== "failed" || task.attempt < TRAIN_MAX_ATTEMPTS) continue;
		if (nextAttempt(ledger, wl, pr) <= TRAIN_MAX_ATTEMPTS) continue;
		const sl = ledger.slice(trainSliceId(wl, pr));
		if (sl && sl.workload_id === wl && (sl.state === "done" || sl.state === "cancelled")) continue;
		// One retry / skip / stop question per failed-twice settle, whoever raised it.
		if (questions.some((q) => q.slice_id === trainSliceId(wl, pr) && q.created_at >= settle.createdAt && (JSON.parse(q.options) as string[]).includes("retry"))) continue;
		out.push({ pr, task, settle });
	}
	return out;
}

/** The failed-twice question: the PR, the task and its settle, what each answer does, then the task's detail (its chain included, D6). */
export function trainRetryQuestionBody(wl: string, d: TwiceFailed): string {
	return [
		`merge train ${wl}: #${d.pr} failed twice: task ${d.task.id} (attempt ${d.task.attempt}, ${d.task.kind}) settled failed: ${d.settle.evidence}. ` +
			`retry gives #${d.pr} two more attempts; skip cancels its train slices; stop holds the train.`,
		"",
		d.task.detail,
	].join("\n");
}

/**
 * Raise the failed-twice alert for `d` (D9) as the tick, in one transaction: the question on `sl-train-<k>-<n>` (the slice added
 * first when the lane never added it), options retry / skip / stop. Null when `twiceFailed` no longer lists the task (raised already,
 * Jo's retry, or the PR is terminal).
 */
export function raiseTwiceFailed(ledger: Ledger, wl: string, d: TwiceFailed): string | null {
	return ledger.write(() => {
		if (!twiceFailed(ledger, wl).some((x) => x.task.id === d.task.id)) return null;
		const sl = ensurePrSlice(ledger, wl, d.pr);
		const asked = askJo(ledger, { by: MERGE_TRAIN_BY, workloadId: wl, sliceId: sl, body: trainRetryQuestionBody(wl, d), options: [...TRAIN_RETRY_OPTIONS] }, { asker: "train" });
		return raisedId(asked, `the retry question of PR #${d.pr}`);
	});
}

// ---- part 3: a green, reviewed lane PR boards a train on its own (PLAN wl-mvbjiettjrfpxc D1-D3) -------------------------

/** D1: a close or released landing receipt older than this is no longer scanned (the scan stays bounded). */
export const AUTOBOARD_WINDOW_MS = 14 * 86_400_000;

/** `train-autoboard: on <iso>`: the cutover the train tick writes once on the standing workload (MERGE_TRAIN_BY); receipts before it never board. */
export function trainAutoboardBody(at: string): string {
	return `train-autoboard: on ${at}`;
}
const AUTOBOARD_RE = /^on (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/;

/** The cutover (D1): the first valid `train-autoboard:` the train tick wrote on the standing workload, its entry and its time; null before one exists. */
export function autoboardCutover(ledger: Pick<Ledger, "entries">): { entryId: string; createdAt: string } | null {
	const c = controlEntries(ledger.entries(STANDING_WORKLOAD_ID)).find((x) => x.prefix === "train-autoboard" && AUTOBOARD_RE.test(x.rest));
	return c ? { entryId: c.id, createdAt: c.createdAt } : null;
}

/** `train-board-skip: workload <W> pr <n|none> head <sha|none> <reason>`, the tick's ledger record of a W that cannot board (D1). */
export function trainBoardSkipBody(wl: string, pr: number | null, head: string | null, reason: string): string {
	return `train-board-skip: workload ${wl} pr ${pr ?? "none"} head ${head ?? "none"} ${reason.replace(/\s+/g, " ").trim()}`;
}

/** A merge train (`trainMembers`) or a train's fix workload (`train-fix:`, the tick's): never a lane PR that boards (D1), and its lane's merge line is its brief's (D10). */
export function isTrainOrFix(entries: readonly EntryRow[], instructions: readonly InstructionRow[]): boolean {
	return trainMembers(entries, instructions).length > 0 || controlEntries(entries).some((c) => c.prefix === "train-fix" && parseTrainFix(c.rest) !== null);
}

/** D1's verdict on workload W: ready to board at a green sha, or why not (the reason the tick's `train-board-skip:` names). */
export type Landing =
	| { ready: true; workloadId: string; pr: number; sha: string; run: string; review: string; checkout: string; repo: string; readyAt: string }
	| { ready: false; workloadId: string; pr: number | null; sha: string | null; reason: string };

/** What `landingReady` reads beyond the ledger: the test runner's config, and how a checkout names its GitHub repository (git; injected in tests). */
export interface LandingContext {
	config: { repos: readonly Pick<TestRunnerConfig["repos"][number], "origin">[] };
	ownerRepo?: (checkout: string) => string | null;
}

/**
 * The review rule (D1): every slice of W that is not a plan question's slice and has a `review-round:` (the lane's or the
 * classifier's) ends its newest loop with `review-loop-end: … reason pass|accept` from a holder lane or the surface (Jo's
 * accept), with no `review-round:` after it, and at least one such slice exists. The newest such end is the review entry.
 */
function reviewPassed(ledger: Ledger, wl: string, entries: readonly EntryRow[], holders: readonly string[]): { ok: true; entryId: string } | { ok: false; reason: string } {
	const control = controlEntries(entries, holders);
	const planQuestions = new Set(control.filter((c) => c.prefix === "plan-question").map((c) => c.rest.split(/\s/)[0]));
	const planSlices = new Set(ledger.questions(wl).filter((q) => planQuestions.has(q.id)).map((q) => q.slice_id));
	const rounds = new Map<string, number>();
	const ends = new Map<string, { at: number; reason: string; entryId: string }>();
	entries.forEach((e, i) => {
		if (e.kind !== "assumption") return;
		const r = holders.includes(e.created_by) || e.created_by === CLASSIFIER_BY ? parseReviewRound(e.body) : null;
		if (r) rounds.set(r.slice, i);
		const end = holders.includes(e.created_by) || e.created_by === SURFACE_BY ? parseReviewLoopEnd(e.body) : null;
		if (end) ends.set(end.slice, { at: i, reason: end.reason, entryId: e.id });
	});
	const reviewed = [...rounds.keys()].filter((sl) => !planSlices.has(sl));
	if (reviewed.length === 0) return { ok: false, reason: "no review round on any slice" };
	let newest: { at: number; entryId: string } | null = null;
	for (const sl of reviewed) {
		const end = ends.get(sl);
		if (!end || end.at < rounds.get(sl)!) return { ok: false, reason: `the review of ${sl} has no loop end after its last round` };
		if (end.reason !== "pass" && end.reason !== "accept") return { ok: false, reason: `the review of ${sl} ended ${end.reason}, not pass or accept` };
		if (newest === null || end.at > newest.at) newest = end;
	}
	return { ok: true, entryId: newest!.entryId };
}

/**
 * D1's ledger half for workload `wl`: ready when W is closed within AUTOBOARD_WINDOW_MS, or released with a fast green on
 * a land-first repository (D9). Released readiness is not closure: no holder, unfinished slices, questions or pending tests
 * may remain, and close still waits for merged/main coverage. W must be autonomous, normal stakes, neither standing nor a
 * train/fix, not superseded/cancelled, on a served repository, with a holder done-because newer than the cutover and a passed
 * review. The newest result must be a green gate (fast only while land-first is on), never red-main. The tick adds gh's live half.
 */
export function landingReady(ledger: Ledger, wl: string, ctx: LandingContext): Landing {
	let pr: number | null = null;
	let sha: string | null = null;
	const no = (reason: string): Landing => ({ ready: false, workloadId: wl, pr, sha, reason });
	const w = ledger.workload(wl);
	if (!w) return no("no such workload");
	if (wl === STANDING_WORKLOAD_ID) return no("the standing workload");
	const open = w.status === "open";
	if (w.mode !== "autonomous") return no(`the workload is ${w.mode}`);
	if (w.stakes !== "normal") return no(`stakes ${w.stakes}`);
	const busy = ownerBusy(ledger, wl);
	if (busy !== null) return no(busy);
	if (open && w.holder !== null) return no("the workload has not been released");
	if (open && ledger.slices(wl).some((s) => s.state === "open" || s.state === "paused")) return no("the workload has open or paused slices");
	if (open && ledger.questions(wl).some((q) => q.state === "open")) return no("the workload has open questions");
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const runs = testRuns(entries);
	const newestRun = runs.at(-1) ?? null;
	if (newestRun !== null) [pr, sha] = [newestRun.request.pr, newestRun.request.sha];
	if (isTrainOrFix(entries, instructions)) return no("a merge train or a fix workload");
	const sup = supersededBy(entries, instructions);
	if (sup !== null) return no(`superseded by ${sup.by}`);
	const holders = holdersOf(entries, w.holder, ledger.holders(wl));
	if (planFirst(controlEntries(entries, holders)) !== null) return no("cancelled: its plan was never approved");
	const checkout = trainCheckout(ledger, wl);
	if (checkout === null) return no("no repo: entry");
	const repo = (ctx.ownerRepo ?? checkoutOwnerRepo)(checkout);
	if (repo === null || !ctx.config.repos.some((r) => r.origin.toLowerCase() === repo.toLowerCase())) return no(`the test runner does not serve ${repo ?? checkout}`);
	const enabled = landFirstOn(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), repo);
	if (open && !enabled) return no("the workload is open");
	if (doneBecause(entries, holders) === null) return no("no holder done-because");
	const receipt = entries.findLast((e) => e.kind === "assumption" && holders.includes(e.created_by) && e.body.trim().startsWith("done-because:"))!;
	const cutover = autoboardCutover(ledger);
	if (cutover === null) return no("no train-autoboard cutover yet");
	if (receipt.created_at <= cutover.createdAt) return no(`done-because ${receipt.id} predates the train-autoboard cutover ${cutover.entryId}`);
	const readyAt = w.closed_at ?? receipt.created_at;
	if (Date.parse(ledger.now()) - Date.parse(readyAt) > AUTOBOARD_WINDOW_MS) return no(open ? "released more than 14 days ago" : "closed more than 14 days ago");
	if (newestRun === null) return no("no full-suite run");
	const result = newestRun.result;
	if (result === null) return no(`the newest run ${newestRun.request.runId} on #${pr} has no result`);
	if (result.verdict !== "green") return no(`the newest run ${newestRun.request.runId} on #${pr} is ${result.verdict}`);
	if (result.scope === "fast" && !enabled) return no("land-first is off: a fast green is not a full-suite result");
	if (open && result.scope !== "fast") return no("the workload is open");
	sha = result.sha;
	const review = reviewPassed(ledger, wl, entries, holders);
	if (!review.ok) return no(review.reason);
	return { ready: true, workloadId: wl, pr: pr!, sha: sha!, run: newestRun.request.runId, review: review.entryId, checkout, repo, readyAt };
}

/**
 * PLAN wl-mvg8itbt0rz3ls D2 rule 3, stricter than the auto-board `reviewPassed`: W's review is settled and passed. The reviewed
 * slices are every slice of W that is not a plan slice (a plan question's slice, the slice of the auto-start's
 * `plan: approved auto …`, which raises no question row, or, while `plan: first` stands unapproved (`planFirst`), the slice that
 * holds the plan role now (`planSlice`), whose plan may be reviewed before its question exists) and has any `review-group:`, review `hand-spawn: … review yes`
 * or `review-round:` entry; at least one exists; each one's newest `review-loop-end:` (from a holder lane or the surface, as
 * `reviewPassed` reads it) is `pass` or `accept`, and after it that slice has no `review-group:`, review `hand-spawn:` or
 * `review-round:` (the later-entry rule of `planAutoStartRound`, surface/extensions/lane-tools.ts): a review dispatched after a
 * pass and not yet settled fails. Otherwise the first failing slice, as a reason.
 */
export function reviewSettledPassed(ledger: Ledger, wl: string): { ok: true } | { ok: false; reason: string } {
	const no = (reason: string) => ({ ok: false as const, reason });
	const entries = ledger.entries(wl);
	const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
	const control = controlEntries(entries, holders);
	const planQuestions = new Set(control.filter((c) => c.prefix === "plan-question").map((c) => c.rest.split(/\s/)[0]));
	const sliceOf = new Map(entries.map((e) => [e.id, e.slice_id]));
	const pending = planFirst(control) !== null ? planSlice(ledger.slices(wl)) : null;
	const planSlices = new Set([
		...ledger.questions(wl).filter((q) => planQuestions.has(q.id)).map((q) => q.slice_id),
		...control.filter((c) => c.prefix === "plan" && /^approved auto\b/.test(c.rest)).map((c) => sliceOf.get(c.id) ?? null),
		...(pending === null ? [] : [pending.id]),
	]);
	/** The slice a review dispatch or round entry is about, or null for any other entry. */
	const reviewOf = (e: EntryRow): string | null => {
		if (e.kind !== "assumption") return null;
		const body = e.body.trim();
		if (parseHandSpawn(body)?.review === true) return e.slice_id;
		return parseReviewGroup(body)?.slice ?? parseReviewRound(body)?.slice ?? null;
	};
	const reviewed = [...new Set(entries.map(reviewOf).filter((sl): sl is string => sl !== null && !planSlices.has(sl)))];
	if (reviewed.length === 0) return no(`${wl} has no review on any slice`);
	for (const sl of reviewed) {
		const endAt = entries.findLastIndex(
			(e) => e.kind === "assumption" && (holders.includes(e.created_by) || e.created_by === SURFACE_BY) && parseReviewLoopEnd(e.body)?.slice === sl,
		);
		if (endAt < 0) return no(`the review of ${sl} on ${wl} has not ended`);
		const reason = parseReviewLoopEnd(entries[endAt]!.body)!.reason;
		if (reason !== "pass" && reason !== "accept") return no(`the review of ${sl} on ${wl} ended ${reason}, not pass or accept`);
		if (entries.slice(endAt + 1).some((e) => reviewOf(e) === sl)) return no(`a review of ${sl} on ${wl} was dispatched after its loop ended ${reason} and has not settled`);
	}
	return { ok: true };
}

/**
 * PLAN wl-mvg8itbt0rz3ls D2: the `trainSignoff` fact Jo's ruling `train-signoff` (gates/src/rulings.ts) reads for PR `pr` on train
 * `train` (repository `trainRepo`), from the ledger, gh's `view` of the PR (TASK_VIEW_FIELDS) and main's `protection` as read
 * live (`mainProtectionGap`). Ok only when all hold, else the first failing rule as the reason:
 * (0) no train slice of `pr` (its disposition slice or a `-full-<r>` one, `trainSlicePr`) has an open question (D6: a merge
 *     question already open stays Jo's), and the train is not held by Jo's stop (`trainHold`: only his train word resumes it);
 * (1) an authenticated Jo `train:` binding on the train names `pr` (`trainBindings` with source jo, every binding: a later
 *     `train <N>` or resume counts, a PR only the tick boarded does not);
 * (2) `branchWorkload` (prStakes' D1 lookup) finds the PR's workload W, W's stakes are production, W has no plan hold
 *     (`planHold`: Jo's `halt`, or the auto-start's) and no plan pending (`planFirst`: `plan: first` with no `plan: approved`);
 * (3) W's review is settled and passed (`reviewSettledPassed`);
 * (4) the newest runner request on `pr` with a result, on the train or on W (`testRuns`; their requests in the ledger's own
 *     order across both workloads, created_at then rowid), is green at the PR's current head `view.headRefOid`: full scope,
 *     or fast scope while land-first is on for `trainRepo` (`landFirstOn`). Production stakes alone do not require full scope.
 *     A full-scope red-main passes too, but only while land-first is off: on a land-first repository the gate posts failure
 *     on a red-main;
 * (5) `protection` is ok.
 * The lane tool calls it inside the `ledger.write` that decides or raises, so a stop, a halt or a question recorded while gh
 * was read is seen here. It is asked only on the PR's disposition slice (`trainSliceId`), the slice the action completes.
 */
export function trainSignoff(ledger: Ledger, train: string, pr: number, view: TaskView, trainRepo: string, protection: Protection): TrainSignoffFact {
	const no = (reason: string): TrainSignoffFact => ({ ok: false, reason });
	const trainEntries = ledger.entries(train);
	const trainInstructions = ledger.instructions(train);
	const trainQuestions = ledger.questions(train);
	if (view.number !== pr) return no(`gh's view is of #${view.number}, not #${pr}`);
	const slice = trainSliceId(train, pr);
	const asked = trainQuestions.find((q) => q.state === "open" && trainSlicePr(q.slice_id, train) === pr);
	if (asked !== undefined) return no(`${asked.slice_id} has open question ${asked.id}: Jo's answer stands`);
	const stopped = trainHold({ entries: trainEntries, instructions: trainInstructions, questions: trainQuestions });
	if (stopped !== null) return no(stopped);
	if (!trainBindings(trainEntries, trainInstructions).some((b) => b.source === "jo" && b.prs.includes(pr))) return no(`no train word of Jo's on ${train} names #${pr}`);
	const b = branchWorkload(view, trainRepo, ledger);
	if (!b.ok) return no(b.reason);
	if (b.w.stakes !== "production") return no(`${b.id}'s stakes are ${b.w.stakes}, not production`);
	const hold = planHold(ledger, b.id);
	if (hold !== null) return no(`${hold.reason}: the train holds its PRs`);
	const wEntries = ledger.entries(b.id);
	const plan = planFirst(controlEntries(wEntries, holdersOf(wEntries, b.w.holder, ledger.holders(b.id))));
	if (plan !== null) return no(`${b.id}'s plan is not approved (plan: first ${plan.trigger})`);
	const review = reviewSettledPassed(ledger, b.id);
	if (!review.ok) return no(review.reason);
	const runs = [...testRuns(trainEntries), ...testRuns(ledger.entries(b.id))].filter((r) => r.request.pr === pr && r.result !== null);
	// The ledger's own order over both workloads' entries (`Ledger.entries` orders by created_at, then rowid): two requests in
	// one millisecond are ordered as they were written, never by which workload they are on.
	const order = new Map(
		ledger.db.query<{ id: string }, [string, string]>("SELECT id FROM entries WHERE workload_id IN (?1, ?2) ORDER BY created_at, rowid").all(train, b.id)
			.map((e, i) => [e.id, i] as const),
	);
	const at = (r: RunRecord): number => order.get(r.request.entryId)!;
	const newest = runs.reduce<RunRecord | null>((a, r) => (a === null || at(r) > at(a) ? r : a), null);
	if (newest === null) return no(`no full-suite run on #${pr} has a result`);
	const result = newest.result!;
	const enabled = landFirstOn(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), trainRepo);
	const greenOk = isFullSuiteGreen(result) || (enabled && result.scope === "fast" && result.verdict === "green");
	const redMainOk = result.verdict === "red-main" && result.scope === "full" && !enabled;
	if (!greenOk && !redMainOk) {
		return no(`the newest run ${result.runId} on #${pr} is ${result.scope === "fast" ? `a fast-check ${result.verdict}` : result.verdict}, not ${enabled ? "green" : "a full-scope green or red-main (land-first is off)"}`);
	}
	if (result.sha !== view.headRefOid) return no(`the newest run ${result.runId} on #${pr} tested ${result.sha}, not its head ${view.headRefOid}`);
	if (protection.state !== "ok") return no(`main's protection on ${trainRepo} is ${protection.state}: ${protection.text}`);
	return { ok: true, pr, slice, repo: trainRepo, head: view.headRefOid, run: result.runId };
}

/** Every workload, open or closed, that ever carried a membership entry (`train:` or `train-board:`) and is a train, oldest first. */
export function everyTrain(ledger: Ledger): string[] {
	return ledger.db.query<{ id: string }, [string, string]>(
		`SELECT w.id AS id FROM workloads w WHERE EXISTS (
		   SELECT 1 FROM entries e WHERE e.workload_id = w.id AND e.kind = 'assumption' AND (
		     (e.created_by = ?1 AND substr(e.body, 1, 6) = 'train:') OR (e.created_by = ?2 AND substr(e.body, 1, 12) = 'train-board:')))
		 ORDER BY w.created_at, w.id`,
	).all(SURFACE_BY, MERGE_TRAIN_BY).map((r) => r.id).filter((wl) => trainPrs(ledger.entries(wl), ledger.instructions(wl)).length > 0);
}

/** `boardLanding`'s answer: the board written (on `train`, opened by it or not), or why nothing was written. */
export type BoardResult = { boarded: true; train: string; opened: boolean; entryId: string } | { boarded: false; reason: string };

/**
 * Board ready landing `l` (D2, D3) in one `ledger.write`, as the train tick (MERGE_TRAIN_BY): `train-board: pr <n> workload <W>
 * head <head> run <run> review <entry>`, `head` the PR's live head the tick read (G when omitted). The transaction first re-reads,
 * over every train of the candidate's repository (`identity`, `repoIdentity` by default): membership (a PR a train worked, i.e.
 * whose PR slice it has, open or closed, never boards: merged, skipped by Jo or left; a PR on an open train is on it already; a
 * board on a closed train with no PR slice is void, R16). For the fixed main target it selects the repo's newest open train:
 * a Jo stop or effective `done-because:` leaves the PR pending, otherwise it appends regardless of train age or spend.
 * Only when no matching open train exists does it open one as `openTrainFix` does: MERGE_TRAIN_BY, autonomous, normal,
 * no `plan:`, no `ceiling:`, `repo:` the candidate's checkout, `done:` TRAIN_DONE, brief `trainBrief(…, "board")`.
 * The board then makes the train `actionable` (`#n boarded`); launch ceiling enforcement is unchanged.
 */
export function boardLanding(
	ledger: Ledger, l: Extract<Landing, { ready: true }>, opts: { head?: string; identity?: (checkout: string) => string } = {},
): BoardResult {
	const identity = opts.identity ?? repoIdentity;
	const want = identity(l.checkout);
	const head = opts.head ?? l.sha;
	if (!SHA_RE.test(head)) return { boarded: false, reason: `head ${head} is not a full sha` };
	const no = (reason: string): BoardResult => ({ boarded: false, reason });
	return ledger.write(() => {
		const w = ledger.workload(l.workloadId);
		if (!w) return no(`${l.workloadId} no longer exists`);
		// GH was read outside this transaction. A reclaim, new slice, run, review or activation change must prevent boarding.
		const fresh = landingReady(ledger, l.workloadId, { config: { repos: [{ origin: l.repo }] } });
		if (!fresh.ready) return no(fresh.reason);
		if (fresh.pr !== l.pr || fresh.sha !== l.sha || fresh.run !== l.run || fresh.review !== l.review || fresh.checkout !== l.checkout || fresh.repo !== l.repo) {
			return no(`${l.workloadId}'s landing changed after the live PR read; retry next pass`);
		}
		const cutover = autoboardCutover(ledger);
		if (cutover === null) return no("no train-autoboard cutover yet");
		const trains = everyTrain(ledger).filter((t) => {
			const checkout = trainCheckout(ledger, t);
			return checkout !== null && identity(checkout) === want;
		});
		for (const t of trains) {
			if (!trainPrs(ledger.entries(t), ledger.instructions(t)).includes(l.pr)) continue;
			const slice = ledger.slice(trainSliceId(t, l.pr));
			if (slice && slice.workload_id === t) return no(`#${l.pr} was worked by merge train ${t} (${trainSliceId(t, l.pr)} ${slice.state})`);
			if (ledger.workload(t)!.status === "open") return no(`#${l.pr} is already on open merge train ${t}`);
		}
		const open = trains.filter((t) => ledger.workload(t)!.status === "open");
		const newest = open.at(-1);
		if (newest !== undefined) {
			const tw = ledger.workload(newest)!;
			const entries = ledger.entries(newest);
			if (trainHold({ entries, instructions: ledger.instructions(newest), questions: ledger.questions(newest) }) !== null)
				return no(`the repository's newest merge train ${newest} is held by Jo's stop`);
			if (doneBecause(entries, holdersOf(entries, tw.holder, ledger.holders(newest))) !== null)
				return no(`the repository's newest merge train ${newest} has a standing done-because`);
		}
		const board = trainBoardBody({ pr: l.pr, workload: l.workloadId, head, run: l.run, review: l.review });
		if (newest !== undefined) {
			const entryId = ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: newest, kind: "assumption", body: board });
			return { boarded: true, train: newest, opened: false, entryId };
		}
		const train = newId("workload");
		ledger.openWorkload({ by: MERGE_TRAIN_BY, id: train, brief: trainBrief(train, [l.pr], "board"), stakes: "normal", mode: "autonomous" });
		for (const body of [`repo: ${l.checkout}`, doneBody(TRAIN_DONE)]) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body });
		const entryId = ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: board });
		return { boarded: true, train, opened: true, entryId };
	});
}

// ---- part 4: the tick's boarding scan and its Jo-facing notices (PLAN wl-mvbjiettjrfpxc D1, D6, D7) ---------------------

/** The reason prefix of a `train-board-skip:` for a PR GitHub shows MERGED or CLOSED: its W is never scanned again (D1). */
export const BOARD_ENDED = "ended:";
const BOARD_SKIP_RE = /^train-board-skip: workload (wl-[a-z0-9]+) pr \S+ head \S+ ([\s\S]+)$/;

/** The tick's earlier `train-board-skip:` rows on the standing workload (MERGE_TRAIN_BY): every body written, and each W whose PR ended. */
export function boardSkips(ledger: Pick<Ledger, "entries">): { bodies: Set<string>; ended: Set<string> } {
	const bodies = new Set<string>();
	const ended = new Set<string>();
	for (const e of ledger.entries(STANDING_WORKLOAD_ID, "assumption")) {
		const m = e.created_by === MERGE_TRAIN_BY ? BOARD_SKIP_RE.exec(e.body) : null;
		if (!m) continue;
		bodies.add(e.body);
		if (m[2]!.startsWith(BOARD_ENDED)) ended.add(m[1]!);
	}
	return { bodies, ended };
}

/** D1/D9's scan: recent closed workloads and released open workloads with a recent landing receipt, newest readiness first. */
export function autoboardCandidates(ledger: Ledger): string[] {
	const since = new Date(Date.parse(ledger.now()) - AUTOBOARD_WINDOW_MS).toISOString();
	return ledger.db.query<{ id: string }, [string, string]>(
		`SELECT w.id FROM workloads w
		 WHERE w.id <> ?2 AND (
		   (w.status = 'closed' AND w.closed_at >= ?1) OR
		   (w.status = 'open' AND w.holder IS NULL AND EXISTS (
		     SELECT 1 FROM entries e WHERE e.workload_id = w.id AND e.kind = 'assumption'
		       AND e.body LIKE 'done-because:%' AND e.created_at >= ?1
		   ))
		 )
		 ORDER BY COALESCE(w.closed_at, (SELECT MAX(e.created_at) FROM entries e
		   WHERE e.workload_id = w.id AND e.kind = 'assumption' AND e.body LIKE 'done-because:%')) DESC, w.id DESC`,
	).all(since, STANDING_WORKLOAD_ID).map((r) => r.id);
}

/**
 * The workloads a merge-train `train-board:` still covers (D1): boarded on a train that is open, or that worked the PR (it has
 * the PR's slice: merged, skipped or left). A board on a closed train without that slice is void (R16): its W is scanned again.
 */
export function boardedWorkloads(ledger: Ledger): Set<string> {
	const out = new Set<string>();
	const rows = ledger.db.query<{ workload_id: string; body: string }, [string]>(
		`SELECT workload_id, body FROM entries WHERE created_by = ?1 AND kind = 'assumption' AND substr(body, 1, 12) = 'train-board:'`,
	).all(MERGE_TRAIN_BY);
	for (const r of rows) {
		const b = parseTrainBoard(r.body.slice("train-board:".length).trim());
		if (b === null) continue;
		if (ledger.workload(r.workload_id)?.status === "open" || ledger.slice(trainSliceId(r.workload_id, b.pr))?.workload_id === r.workload_id) out.add(b.workload);
	}
	return out;
}

/** D6: an `unknown` read raises only once it is the newest read and at least this old. */
export const PROTECTION_UNKNOWN_RAISE_MS = 10 * 60_000;
/** D7: a train closed longer ago than this is no longer read for `main-red:` rows. */
export const MAIN_RED_WINDOW_MS = 24 * 3_600_000;

/**
 * The rows of a protection episode (D6), on the standing workload as MERGE_TRAIN_BY: `ok`, `gap` and `unknown` record each change
 * of the live read (a gap's changed text too); `raised` opens the episode (its needs-you line), `filed <issue url>` its jo-issues
 * issue, `cleared <why>` ends it.
 */
export type ProtectionNoticeState = "ok" | "gap" | "unknown" | "raised" | "filed" | "cleared";

/** `train-notice: protection <owner/repo> <state> <text>`. */
export function protectionNoticeBody(repo: string, state: ProtectionNoticeState, text: string): string {
	return `train-notice: protection ${repo.toLowerCase()} ${state} ${text.replace(/\s+/g, " ").trim()}`;
}
const PROTECTION_NOTICE_RE = /^protection ([^\s/]+\/[^\s/]+) (ok|gap|unknown|raised|filed|cleared) ([\s\S]+)$/;

/** One `train-notice:` row. */
export interface NoticeRow {
	id: string;
	createdAt: string;
	state: string;
	text: string;
}

/** One repository's protection episodes (D6), read from its `train-notice: protection` rows in order. */
export interface ProtectionEpisode {
	repo: string;
	/** The newest read row (`ok`, `gap` or `unknown`); null before the first read. */
	read: NoticeRow | null;
	/** The open episode's `raised` row; null when no episode is open. */
	raised: NoticeRow | null;
	/** The open episode's jo-issues issue (`filed`); null before it is filed. */
	issue: string | null;
	/** The open episode's newest text: its newest gap or unknown row since `raised`, else `raised`'s own. */
	text: string;
}

/** Every repository's protection episodes (D6), by lowercase `owner/repo`. */
export function protectionEpisodes(ledger: Pick<Ledger, "entries">): Map<string, ProtectionEpisode> {
	const out = new Map<string, ProtectionEpisode>();
	for (const c of controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"))) {
		const m = c.prefix === "train-notice" ? PROTECTION_NOTICE_RE.exec(c.rest) : null;
		if (!m) continue;
		const row: NoticeRow = { id: c.id, createdAt: c.createdAt, state: m[2]!, text: m[3]! };
		const ep = out.get(m[1]!) ?? { repo: m[1]!, read: null, raised: null, issue: null, text: "" };
		out.set(ep.repo, ep);
		if (row.state === "ok" || row.state === "gap" || row.state === "unknown") {
			ep.read = row;
			if (ep.raised && row.state !== "ok") ep.text = row.text;
		} else if (row.state === "raised") {
			[ep.raised, ep.issue, ep.text] = [row, null, row.text];
		} else if (row.state === "filed") {
			if (ep.raised) ep.issue = row.text;
		} else {
			[ep.raised, ep.issue, ep.text] = [null, null, ""];
		}
	}
	return out;
}

/** `train-notice: main-red <url> raised run <id>`, `… filed <jo-issues url>` or `… cleared <why>` (D7), on the standing workload. */
export function mainRedNoticeBody(url: string, state: "raised" | "filed" | "cleared", text: string): string {
	return `train-notice: main-red ${url} ${state} ${text.replace(/\s+/g, " ").trim()}`;
}
const MAIN_RED_NOTICE_RE = /^main-red (\S+) (raised|filed|cleared) ([\s\S]+)$/;

/** One main-red issue's notice (D7): raised once per url. */
export interface MainRedNotice {
	url: string;
	raised: NoticeRow;
	run: string;
	/** The jo-issues issue (`filed`); null before it is filed. */
	issue: string | null;
	cleared: NoticeRow | null;
}

/** Every main-red notice (D7) by its issue url. */
export function mainRedNotices(ledger: Pick<Ledger, "entries">): Map<string, MainRedNotice> {
	const out = new Map<string, MainRedNotice>();
	for (const c of controlEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"))) {
		const m = c.prefix === "train-notice" ? MAIN_RED_NOTICE_RE.exec(c.rest) : null;
		if (!m) continue;
		const row: NoticeRow = { id: c.id, createdAt: c.createdAt, state: m[2]!, text: m[3]! };
		const n = out.get(m[1]!);
		if (row.state === "raised") {
			if (!n) out.set(m[1]!, { url: m[1]!, raised: row, run: row.text.replace(/^run /, ""), issue: null, cleared: null });
		} else if (n && row.state === "filed") n.issue ??= row.text;
		else if (n && row.state === "cleared") n.cleared ??= row;
	}
	return out;
}

const MAIN_RED_RE = /^main-red: (\S+) run (\S+)$/;

/** A holder's `main-red: <url> run <id>` on a train (D7): `valid` when url is an issue on that train's own repository. */
export interface MainRedRow {
	train: string;
	entryId: string;
	url: string;
	run: string;
	repo: string | null;
	valid: boolean;
}

/** Every holder `main-red:` row on a train open now or closed within MAIN_RED_WINDOW_MS (D7), oldest train first, in entry order. */
export function mainRedRows(ledger: Ledger, ownerRepo: (checkout: string) => string | null = checkoutOwnerRepo): MainRedRow[] {
	const since = new Date(Date.parse(ledger.now()) - MAIN_RED_WINDOW_MS).toISOString();
	const out: MainRedRow[] = [];
	for (const t of everyTrain(ledger)) {
		const w = ledger.workload(t)!;
		if (w.status === "closed" && w.closed_at! < since) continue;
		const entries = ledger.entries(t);
		const holders = holdersOf(entries, w.holder, ledger.holders(t));
		let repo: string | null | undefined;
		for (const e of entries) {
			const m = e.kind === "assumption" && holders.includes(e.created_by) ? MAIN_RED_RE.exec(e.body.trim()) : null;
			if (!m) continue;
			if (repo === undefined) {
				const checkout = trainCheckout(ledger, t);
				repo = checkout === null ? null : ownerRepo(checkout);
			}
			const issue = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/[1-9]\d*$/.exec(m[1]!);
			out.push({ train: t, entryId: e.id, url: m[1]!, run: m[2]!, repo, valid: issue !== null && repo !== null && issue[1]!.toLowerCase() === repo.toLowerCase() });
		}
	}
	return out;
}

const PROTECTION_PASS_RE = /^train-error:\s+pr\s+[1-9]\d*\s+protection\b/;
/** The train brief's pass-over while landing is stopped (PLAN wl-mvq4edbaf13vnk D9): `train-error: pr <n> landing-stopped <reason>`. */
const LANDING_PASS_RE = /^train-error:\s+pr\s+[1-9]\d*\s+landing-stopped\b/;

/** The PRs of train `wl`, not terminal, whose newest holder pass-over (`train-error: pr <n> …`) matches `kind`. */
function passOversOf(ledger: Ledger, wl: string, kind: RegExp): Set<number> {
	const entries = ledger.entries(wl);
	const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
	const newest = new Map<number, boolean>();
	for (const e of entries) {
		const p = e.kind === "assumption" && holders.includes(e.created_by) ? PASSED_OVER_RE.exec(e.body.trim()) : null;
		if (p) newest.set(Number(p[1]), kind.test(e.body.trim()));
	}
	const out = new Set<number>();
	for (const [n, matched] of newest) {
		const sl = ledger.slice(trainSliceId(wl, n));
		if (matched && !(sl && (sl.state === "done" || sl.state === "cancelled"))) out.add(n);
	}
	return out;
}

/**
 * The PRs of train `wl`, not terminal, whose newest holder pass-over (`train-error: pr <n> …`) is for main's protection (D5's
 * `train-error: pr <n> protection <gap>`): D6 holds their backoff wake while the episode is open and wakes the train when it clears.
 */
export function protectionPassOvers(ledger: Ledger, wl: string): Set<number> {
	return passOversOf(ledger, wl, PROTECTION_PASS_RE);
}

/**
 * The PRs of train `wl`, not terminal, whose newest holder pass-over is `train-error: pr <n> landing-stopped …` (PLAN
 * wl-mvq4edbaf13vnk D9): the tick holds their backoff wake while the repository's landing is stopped and wakes the train when it reopens (D6).
 */
export function landingPassOvers(ledger: Ledger, wl: string): Set<number> {
	return passOversOf(ledger, wl, LANDING_PASS_RE);
}

// ---- the train's own lane outside the cap (PLAN wl-mvpsrr4tr0p1xc D2, D4) -------------------------------------------

const READY_AT_RE = /^at (\S+)$/;

/**
 * D2: the newest prompt row cut on a workload: the time the newest `lane-ready: <laneId> at <iso>` of a lane some `launch:`
 * attempt named carries (the runner takes it before `promptFor` reads the rows), or that entry's own time when its body
 * names none; null when no launched lane ever got ready.
 */
export function lastReadyAt(control: readonly ControlEntry[]): string | null {
	const launched = new Set(attempts(control).map((a) => a.laneId));
	let out: string | null = null;
	for (const c of control) {
		if (c.prefix !== "lane-ready" || c.laneId === null || !launched.has(c.laneId)) continue;
		const at = READY_AT_RE.exec(c.rest)?.[1] ?? c.createdAt;
		if (out === null || at > out) out = at;
	}
	return out;
}

/**
 * D2's consumption rule for a cap-exempt train, one rule for every cause: the resolution whose instruction was written at
 * `instructionAt` is consumed when some launched lane wrote a `lane-ready:` whose time is later (strict, `lastReadyAt`), so
 * it was in that lane's first prompt. Naming it in a `launch: … cause resume` consumes nothing: a launch that never gets ready
 * leaves it to wake the train again (bounded by `trainLaunchFailures`). `launchable` applies it to a cap-exempt workload's
 * resolutions; the tick's `actionable` reads it for an answered or withdrawn lane question.
 */
export function consumedByReady(control: readonly ControlEntry[], instructionAt: string): boolean {
	const cut = lastReadyAt(control);
	return cut !== null && instructionAt < cut;
}

/** D4: this many consecutive train launches that never got ready stop every launch path (PR #308's `RETRY_LIMIT` number, not an import). */
export const TRAIN_LAUNCH_LIMIT = 3;
/** D4: the options of Jo's NOW question at the limit: `relaunch` resets the count, `stop` leaves it. Not `retry` (`twiceFailed` reads that). */
export const TRAIN_LAUNCH_OPTIONS: readonly string[] = ["relaunch", "stop"];

/** What `trainLaunchFailures` reads: the train's rows and its holder now. */
export interface TrainLaunchRows {
	entries: readonly EntryRow[];
	instructions: readonly InstructionRow[];
	questions: readonly QuestionRow[];
	holder: string | null;
	holderLeaseUntil: string | null;
	now: string;
}

/** The consecutive failed launches since the newest reset (D4), oldest first. */
export interface TrainLaunchFailures {
	count: number;
	/** The counted attempts' lane ids. */
	lanes: string[];
	/** One line per counted attempt: `<laneId> (<launch time>): <why it ended without readiness>`. */
	failures: string[];
	/** The oldest and newest counted attempt's `launch:` time; null when none is counted. */
	first: string | null;
	last: string | null;
}

/**
 * D4: the train's `launch:` attempts after the newest reset, walked newest first, counting each that has no `lane-ready:` and
 * has ended: it has a `launch-failed:` or a `lane-exit: … outcome never-ready`, or a later attempt exists, or it is the newest
 * attempt and the workload is no longer held by it under a live lease (a starter or runner that died before readiness without
 * finalizing). The walk stops at an attempt whose lane wrote `lane-ready:` and at a by-hand attempt (`cause interactive`: Jo's
 * session gets its first prompt from a file and has no runner readiness step, so it is never a failed launch, as
 * `neverReadyLanes` reads it); the newest attempt still held under a live lease and not ready is in flight and not counted. A
 * reset is Jo's `launch-requested: by jo`, Jo's `relaunch` answer to the D4 question (the tick's, options
 * `TRAIN_LAUNCH_OPTIONS`) or a `train:` binding; an attempt counts only when written after it (entry order on a tie with an
 * entry, the attempt on a tie with an answer). Pure: pass the rows one read took.
 */
export function trainLaunchFailures(rows: TrainLaunchRows): TrainLaunchFailures {
	const control = controlEntries(rows.entries, holdersOf(rows.entries, rows.holder));
	const order = new Map(control.map((c, i) => [c.id, i]));
	const resets: { at: string; index: number | null }[] = [];
	for (const c of control) {
		if (c.prefix === "launch-requested" && c.createdBy === SURFACE_BY && /^by jo\b/.test(c.rest)) resets.push({ at: c.createdAt, index: order.get(c.id)! });
	}
	for (const b of prBindings(rows.entries, rows.instructions, ["train"])) {
		const index = order.get(b.entryId);
		if (index !== undefined) resets.push({ at: b.createdAt, index });
	}
	for (const q of rows.questions) {
		if (q.created_by !== MERGE_TRAIN_BY || !(JSON.parse(q.options) as string[]).includes("relaunch")) continue;
		const ins = joAnswer(q, rows.instructions, "relaunch");
		if (ins) resets.push({ at: ins.created_at, index: null });
	}
	const reset = resets.reduce<{ at: string; index: number | null } | null>((a, r) => (a === null || r.at > a.at || (r.at === a.at && (r.index ?? Infinity) > (a.index ?? Infinity)) ? r : a), null);
	const list = attempts(control).filter((a) => reset === null || a.createdAt > reset.at || (a.createdAt === reset.at && (reset.index === null || order.get(a.entryId)! > reset.index)));
	const counted: { laneId: string; at: string; line: string }[] = [];
	const live = heldLive({ holder: rows.holder, holder_lease_until: rows.holderLeaseUntil }, rows.now);
	for (let i = list.length - 1; i >= 0; i--) {
		const a = list[i]!;
		if (a.cause?.kind === "interactive" || control.some((c) => c.prefix === "lane-ready" && c.laneId === a.laneId)) break;
		const failed = control.find((c) => c.prefix === "launch-failed" && c.laneId === a.laneId);
		const exit = laneExit(control, a.laneId);
		const next = list[i + 1];
		const why = failed ? `launch-failed: ${failed.rest}`
			: exit?.outcome === "never-ready" ? "lane-exit: outcome never-ready"
			: next ? `no lane-ready:, superseded by ${next.laneId}${exit ? ` (lane-exit: outcome ${exit.outcome})` : ""}`
			: rows.holder === a.laneId && live ? null
			: `no lane-ready:, ${rows.holder === a.laneId ? "its lease lapsed" : `the workload is held by ${rows.holder ?? "no one"}`}${exit ? ` (lane-exit: outcome ${exit.outcome})` : ""}`;
		if (why !== null) counted.unshift({ laneId: a.laneId, at: a.createdAt, line: `${a.laneId} (${a.createdAt}): ${why}` });
	}
	return {
		count: counted.length,
		lanes: counted.map((c) => c.laneId),
		failures: counted.map((c) => c.line),
		first: counted[0]?.at ?? null,
		last: counted.at(-1)?.at ?? null,
	};
}

/** D4's question body: the count, the time span and lanes, what each answer does, then each failure line. */
export function trainLaunchLimitBody(wl: string, f: TrainLaunchFailures): string {
	return [
		`merge train ${wl}: ${f.count} consecutive launches never got ready, ${f.first} to ${f.last} (lanes ${f.lanes.join(", ")}); ` +
			"nothing launches the train until you answer. relaunch resets the count and the next tick pass relaunches it; " +
			"stop leaves it stopped until your launch word or a train word.",
		"",
		...f.failures.map((line) => `- ${line}`),
	].join("\n");
}

/**
 * D4 (PLAN wl-mvpsrr4tr0p1xc), the tick's side, in one transaction: at the limit (`trainLaunchFailures` counts
 * TRAIN_LAUNCH_LIMIT), Jo's NOW question, once per episode: unless a D4 question (the tick's, options TRAIN_LAUNCH_OPTIONS)
 * open or resolved was created at or after the episode's first counted attempt, `askJo(…, now: "incident")` on the slice of
 * the train's first non-terminal PR in `trainPrs` order (added as the tick when no lane added it), so its needs-you line is
 * `NOW (incident)` and on fire, and the alert ladder files its jo-issues issue. Returns the question id, null when none is
 * owed, or `{ noSlice }` when the train has no non-terminal PR to carry it.
 */
export function raiseLaunchLimit(ledger: Ledger, wl: string): string | { noSlice: true } | null {
	return ledger.write(() => {
		const w = ledger.workload(wl);
		if (!w) return null;
		const questions = ledger.questions(wl);
		const instructions = ledger.instructions(wl);
		const entries = ledger.entries(wl);
		const f = trainLaunchFailures({ entries, instructions, questions, holder: w.holder, holderLeaseUntil: w.holder_lease_until, now: ledger.now() });
		if (f.count < TRAIN_LAUNCH_LIMIT || f.first === null) return null;
		const asked = questions.some((q) => q.created_by === MERGE_TRAIN_BY && (JSON.parse(q.options) as string[]).includes("relaunch") && q.created_at >= f.first!);
		if (asked) return null;
		const pr = trainPrs(entries, instructions).find((n) => {
			const sl = ledger.slice(trainSliceId(wl, n));
			return !(sl && (sl.state === "done" || sl.state === "cancelled"));
		});
		if (pr === undefined) return { noSlice: true };
		const sl = ensurePrSlice(ledger, wl, pr);
		const r = askJo(ledger, { by: MERGE_TRAIN_BY, workloadId: wl, sliceId: sl, body: trainLaunchLimitBody(wl, f), options: [...TRAIN_LAUNCH_OPTIONS], now: "incident" }, { asker: "train" });
		return raisedId(r, `the launch limit question of ${wl}`);
	});
}

// ---- land-first: the tick's rows on the standing workload (PLAN wl-mvq4edbaf13vnk D6-D8) ----------------------------------

/** What one tick pass reconciled for one repository (D6): landing state, its reasons, the oldest suspect, the repair head and the watermark. */
export interface TrainReconciled {
	/** Lowercase `owner/repo`. */
	repo: string;
	/** The pass's ledger time, ISO. */
	at: string;
	tip: string;
	g: string | null;
	open: boolean;
	/** When the oldest suspect landed, ISO; null with no suspects. */
	oldest: string | null;
	/** The head the gate posted the incident's repair success on, while stopped (D7); null otherwise. */
	repair: string | null;
	/** The entry id of the newest main-run settle the pass read (§ 2's watermark); null when none exists. */
	read: string | null;
	/** Every reason landing is stopped, `; `-joined; empty when open. */
	reasons: string;
}

const RECONCILED_RE = /^train-reconciled: repo (\S+\/\S+) at (\S+) tip ([0-9a-f]{40}) g ([0-9a-f]{40}|none) landing (open|stopped) oldest (\S+) repair ([0-9a-f]{40}|none) read (en-[a-z0-9]+|none) reasons (.*)$/;

/**
 * `train-reconciled: repo <owner/repo> at <iso> tip <sha> g <sha|none> landing open|stopped oldest <iso|none> repair <sha|none>
 * read <en-…|none> reasons <…>`: the tick's alone (MERGE_TRAIN_BY), on the standing workload, one line, `reasons` last (`none` when empty).
 */
export function trainReconciledBody(r: TrainReconciled): string {
	const reasons = r.reasons.replace(/\s+/g, " ").trim();
	const body = `train-reconciled: repo ${r.repo.toLowerCase()} at ${r.at} tip ${r.tip} g ${r.g ?? "none"} landing ${r.open ? "open" : "stopped"} oldest ${r.oldest ?? "none"} repair ${r.repair ?? "none"} read ${r.read ?? "none"} reasons ${reasons === "" ? "none" : reasons}`;
	if (parseTrainReconciled(body) === null) throw new Error(`train-reconciled: the body for ${r.repo} at ${r.at} does not parse (a sha or time is malformed): ${body}`);
	return body;
}

/** A full `train-reconciled:` body parsed, or null when it is not that shape. */
export function parseTrainReconciled(body: string): TrainReconciled | null {
	const m = RECONCILED_RE.exec(body.trim());
	if (!m || !Number.isFinite(Date.parse(m[2]!)) || (m[6] !== "none" && !Number.isFinite(Date.parse(m[6]!)))) return null;
	const none = (s: string) => (s === "none" ? null : s);
	return { repo: m[1]!, at: m[2]!, tip: m[3]!, g: none(m[4]!), open: m[5] === "open", oldest: none(m[6]!), repair: none(m[7]!), read: none(m[8]!), reasons: m[9] === "none" ? "" : m[9]! };
}

/** The newest valid `train-reconciled:` the tick wrote (`controlEntries` drops any other writer) for `repo`, with its entry; null when none. */
export function latestTrainReconciled(entries: readonly EntryRow[], repo: string): { entryId: string; createdAt: string; r: TrainReconciled } | null {
	const want = repo.toLowerCase();
	let out: { entryId: string; createdAt: string; r: TrainReconciled } | null = null;
	for (const c of controlEntries(entries)) {
		const r = c.prefix === "train-reconciled" ? parseTrainReconciled(c.body) : null;
		if (r !== null && r.repo === want) out = { entryId: c.id, createdAt: c.createdAt, r };
	}
	return out;
}

/** An inconclusive main run is re-requested only once it is this old (§ 2 Attempts, D6). */
export const MAIN_RETRY_MS = 15 * 60_000;
/** Landing stops longer than this after the repair's wake have not been repaired (D6, F3): one repair-failed notice. */
export const REPAIR_FAIL_MS = 30 * 60_000;
/** Revocation posts per open head before the tick gives up on it (D6, F6). */
export const REVOKE_ATTEMPTS = 3;
/** Promotion attempts per verified commit G before the tick gives up on it (§ 2 Protect the verifier, R31). */
export const PROMOTE_ATTEMPTS = 3;
/** The render's stale-tick bound (D8): no `train-reconciled:` this recent while land-first is on. */
export const RECONCILED_STALE_MS = 15 * 60_000;

/**
 * One of the tick's land-first rows (D6), `train-notice: land-first <repo> <event> …` on the standing workload as MERGE_TRAIN_BY
 * (`tick-refused` names the repository `*`: the self-check is the tick's, not a repository's):
 * - `exhausted <sha> block <n>`: main commit `sha`'s attempt block n is exhausted (§ 2 Attempts), once per block;
 * - `revoke-failed #<n> <head> attempt <k> <error>`, `revoke-gave-up #<n> <head> <error>` after REVOKE_ATTEMPTS, and
 *   `revoke-cleared #<n> <head> <why>` once that head is no longer the PR's open head;
 * - `stop-raised` / `stop-updated <kind> tip <sha> g <sha|none> suspects <#n,…|none> failing <n|none>`: a stop episode opens or
 *   changes kind or tip; `stop-filed <issue url>` its jo-issues issue (regression or infrastructure); `stop-cleared <why>` ends it;
 * - `repair-woken <tip> train <wl|none>` (D7, once per episode) and `repair-failed <tip> woken <iso>` 30 minutes on;
 * - `promote-failed <g> attempt <k> <error>`, `promote-gave-up <g> <error>`, `promote-schema <barrier> target <g> current
 *   <sha|none> issue <url|none>` (schema barrier and the actual verified target; old rows have no target) and `promote-ok <g>`;
 * - `tick-refused <reason>`: the tick's self-check refused while land-first is on.
 */
export type LandFirstEvent =
	| { event: "exhausted"; sha: string; block: number }
	| { event: "revoke-failed"; pr: number; head: string; attempt: number; error: string }
	| { event: "revoke-gave-up"; pr: number; head: string; error: string }
	| { event: "revoke-cleared"; pr: number; head: string; why: string }
	| { event: "stop-raised" | "stop-updated"; kind: "regression" | "infrastructure" | "depth"; tip: string; g: string | null; suspects: number[]; failing: number | null }
	| { event: "stop-filed"; url: string }
	| { event: "stop-cleared"; why: string }
	| { event: "repair-woken"; tip: string; train: string | null }
	| { event: "repair-failed"; tip: string; woken: string }
	| { event: "promote-failed"; g: string; attempt: number; error: string }
	| { event: "promote-gave-up"; g: string; error: string }
	| { event: "promote-schema"; sha: string; g: string | null; current: string | null; issue: string | null }
	| { event: "promote-ok"; g: string }
	| { event: "tick-refused"; reason: string };
export type LandFirstRow = LandFirstEvent & { repo: string; entryId: string; createdAt: string };

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim() || "none";

/** `train-notice: land-first <repo> <event> …` for `e` (`LandFirstEvent`); free text is put on one line. */
export function landFirstNoticeBody(repo: string, e: LandFirstEvent): string {
	const none = (s: string | null) => s ?? "none";
	const rest = ((): string => {
		switch (e.event) {
			case "exhausted": return `${e.sha} block ${e.block}`;
			case "revoke-failed": return `#${e.pr} ${e.head} attempt ${e.attempt} ${oneLine(e.error)}`;
			case "revoke-gave-up": return `#${e.pr} ${e.head} ${oneLine(e.error)}`;
			case "revoke-cleared": return `#${e.pr} ${e.head} ${oneLine(e.why)}`;
			case "stop-raised":
			case "stop-updated":
				return `${e.kind} tip ${e.tip} g ${none(e.g)} suspects ${e.suspects.length === 0 ? "none" : e.suspects.map((n) => `#${n}`).join(",")} failing ${e.failing ?? "none"}`;
			case "stop-filed": return e.url;
			case "stop-cleared": return oneLine(e.why);
			case "repair-woken": return `${e.tip} train ${none(e.train)}`;
			case "repair-failed": return `${e.tip} woken ${e.woken}`;
			case "promote-failed": return `${e.g} attempt ${e.attempt} ${oneLine(e.error)}`;
			case "promote-gave-up": return `${e.g} ${oneLine(e.error)}`;
			case "promote-schema": return `${e.sha} target ${none(e.g)} current ${none(e.current)} issue ${none(e.issue)}`;
			case "promote-ok": return e.g;
			case "tick-refused": return oneLine(e.reason);
		}
	})();
	return `train-notice: land-first ${repo.toLowerCase()} ${e.event} ${rest}`;
}

const LF_NOTICE_RE = /^land-first (\S+) (\S+) (.*)$/;
const SHA = "([0-9a-f]{40})";
const SHA_OR_NONE = "([0-9a-f]{40}|none)";
const STOP_STATE = `(regression|infrastructure|depth) tip ${SHA} g ${SHA_OR_NONE} suspects (none|#[1-9]\\d*(?:,#[1-9]\\d*)*) failing (none|\\d+)`;
const LF_EVENT_RE: Record<LandFirstEvent["event"], RegExp> = {
	exhausted: new RegExp(`^${SHA} block ([1-9]\\d*)$`),
	"revoke-failed": new RegExp(`^#([1-9]\\d*) ${SHA} attempt ([1-9]\\d*) (.+)$`),
	"revoke-gave-up": new RegExp(`^#([1-9]\\d*) ${SHA} (.+)$`),
	"revoke-cleared": new RegExp(`^#([1-9]\\d*) ${SHA} (.+)$`),
	"stop-raised": new RegExp(`^${STOP_STATE}$`),
	"stop-updated": new RegExp(`^${STOP_STATE}$`),
	"stop-filed": /^(https:\/\/\S+)$/,
	"stop-cleared": /^(.+)$/,
	"repair-woken": new RegExp(`^${SHA} train (wl-[a-z0-9]+|none)$`),
	"repair-failed": new RegExp(`^${SHA} woken (\\S+)$`),
	"promote-failed": new RegExp(`^${SHA} attempt ([1-9]\\d*) (.+)$`),
	"promote-gave-up": new RegExp(`^${SHA} (.+)$`),
	"promote-schema": new RegExp(`^${SHA}(?: target ${SHA_OR_NONE})? current ${SHA_OR_NONE} issue (https:\\/\\/\\S+|none)$`),
	"promote-ok": new RegExp(`^${SHA}$`),
	"tick-refused": /^(.+)$/,
};

/** One `train-notice: land-first …` rest (`controlEntries`' `rest`) parsed, or null when it is not that shape. */
function parseLandFirst(rest: string): (LandFirstEvent & { repo: string }) | null {
	const top = LF_NOTICE_RE.exec(rest);
	if (!top || !Object.hasOwn(LF_EVENT_RE, top[2]!)) return null;
	const event = top[2] as LandFirstEvent["event"];
	const m = LF_EVENT_RE[event].exec(top[3]!);
	if (!m) return null;
	const repo = top[1]!;
	const orNull = (s: string) => (s === "none" ? null : s);
	switch (event) {
		case "exhausted": return { repo, event, sha: m[1]!, block: Number(m[2]) };
		case "revoke-failed": return { repo, event, pr: Number(m[1]), head: m[2]!, attempt: Number(m[3]), error: m[4]! };
		case "revoke-gave-up": return { repo, event, pr: Number(m[1]), head: m[2]!, error: m[3]! };
		case "revoke-cleared": return { repo, event, pr: Number(m[1]), head: m[2]!, why: m[3]! };
		case "stop-raised":
		case "stop-updated":
			return {
				repo, event, kind: m[1] as "regression" | "infrastructure" | "depth", tip: m[2]!, g: orNull(m[3]!),
				suspects: m[4] === "none" ? [] : m[4]!.split(",").map((s) => Number(s.slice(1))), failing: m[5] === "none" ? null : Number(m[5]),
			};
		case "stop-filed": return { repo, event, url: m[1]! };
		case "stop-cleared": return { repo, event, why: m[1]! };
		case "repair-woken": return { repo, event, tip: m[1]!, train: orNull(m[2]!) };
		case "repair-failed": return { repo, event, tip: m[1]!, woken: m[2]! };
		case "promote-failed": return { repo, event, g: m[1]!, attempt: Number(m[2]), error: m[3]! };
		case "promote-gave-up": return { repo, event, g: m[1]!, error: m[2]! };
		case "promote-schema": return { repo, event, sha: m[1]!, g: m[2] === undefined ? null : orNull(m[2]), current: orNull(m[3]!), issue: orNull(m[4]!) };
		case "promote-ok": return { repo, event, g: m[1]! };
		case "tick-refused": return { repo, event, reason: m[1]! };
	}
}

/** Every valid land-first row the tick wrote (`controlEntries` drops any other writer), oldest first; `repo` filters (lowercase) when given. */
export function landFirstRows(entries: readonly EntryRow[], repo?: string): LandFirstRow[] {
	const out: LandFirstRow[] = [];
	for (const c of controlEntries(entries)) {
		const r = c.prefix === "train-notice" ? parseLandFirst(c.rest) : null;
		if (r !== null && (repo === undefined || r.repo === repo.toLowerCase())) out.push({ ...r, entryId: c.id, createdAt: c.createdAt });
	}
	return out;
}

/** A repository's open stop episode (D6): its opening row, its newest state, its issue and its repair rows; null when none is open. */
export interface StopEpisode {
	raised: Extract<LandFirstRow, { event: "stop-raised" }>;
	/** The newest `stop-raised` or `stop-updated` of the episode. */
	state: Extract<LandFirstRow, { event: "stop-raised" | "stop-updated" }>;
	filed: string | null;
	woken: Extract<LandFirstRow, { event: "repair-woken" }> | null;
	failed: Extract<LandFirstRow, { event: "repair-failed" }> | null;
}

/** The open stop episode among one repository's rows (`landFirstRows(entries, repo)`): the newest `stop-raised` with no `stop-cleared` after it. */
export function stopEpisode(rows: readonly LandFirstRow[]): StopEpisode | null {
	let ep: StopEpisode | null = null;
	for (const r of rows) {
		if (r.event === "stop-raised") ep = { raised: r, state: r, filed: null, woken: null, failed: null };
		else if (ep === null) continue;
		else if (r.event === "stop-updated") ep.state = r;
		else if (r.event === "stop-filed") ep.filed = r.url;
		else if (r.event === "repair-woken") ep.woken = r;
		else if (r.event === "repair-failed") ep.failed = r;
		else if (r.event === "stop-cleared") ep = null;
	}
	return ep;
}

/** One stop episode in a sentence (D6): what stopped, where, G, the suspects, why, and the next step; the head of its jo-issues issue. */
export function stopSummary(repo: string, s: { kind: string; tip: string; g: string | null; suspects: number[]; reasons: string[] }): string {
	const next = s.kind === "regression"
		? "next: the merge train reverts the suspects (one attempt per wake), or an owner names a fix PR in this issue"
		: s.kind === "infrastructure"
			? `next: the tick re-requests main's run (3 per block); if the runner is broken, fix it, then say main-retry ${repo}`
			: "next: main's runs of the suspects reopen landing once they are green";
	return `Landing stopped on ${repo} (${s.kind}) at ${s.tip.slice(0, 7)}, G ${s.g?.slice(0, 7) ?? "none"}, suspects ${s.suspects.length === 0 ? "none" : s.suspects.map((n) => `#${n}`).join(", ")}: ${s.reasons.join("; ")}. ${next}.`;
}

/**
 * Every repository land-first is on for now, lowercase; `includePendingOff` also includes repositories
 * whose off revocations are unfinished. Prefer the full owner/repo from tick rows over Jo's short name.
 */
export function landFirstRepos(entries: readonly EntryRow[], instructions: readonly InstructionRow[], includePendingOff = false): string[] {
	const full = new Set<string>();
	for (const c of controlEntries(entries)) {
		const r = c.prefix === "train-reconciled" ? parseTrainReconciled(c.body)?.repo : c.prefix === "train-notice" ? parseLandFirst(c.rest)?.repo : undefined;
		if (r !== undefined && r !== "*") full.add(r);
	}
	const named = controlEntries(entries).filter((c) => c.prefix === "land-first").map((c) => c.rest.split(" ")[0]!.toLowerCase());
	const out = new Set(full);
	for (const n of named) if (![...full].some((f) => sameRepo(f, n))) out.add(n);
	return [...out].filter((r) => includePendingOff ? landFirstHeld(entries, instructions, r) : landFirstOn(entries, instructions, r)).sort();
}

/** A control process's own root as git and the file system read it now (§ 2 Protect the verifier, Self-checks). */
export interface ControlRoot {
	/** The repository root, symlinks resolved. */
	root: string;
	/** Its HEAD commit. */
	head: string;
	/** Tracked files with changes (`git status --porcelain --untracked-files=no`). */
	modified: string[];
	/** `~/.agent-system-2/verified/current`, symlinks resolved; null when it does not exist. */
	current: string | null;
	/** The commit `current` has checked out; null when `current` does not exist. */
	currentHead: string | null;
	/** The root's origin as lowercase `owner/repo`; null when it has none GitHub names. */
	repo: string | null;
}

/**
 * Why a control root fails § 2's self-check, every reason. New processes load `verified/current`; a process already
 * running may finish from an older immutable sibling `verified/<HEAD 12>` after promotion. Either root must have a
 * green believable main verdict and unmodified tracked files. An arbitrary checkout or sibling name is never accepted.
 */
export function controlRootRefusal(r: ControlRoot, entries: readonly EntryRow[]): string[] {
	const out: string[] = [];
	if (r.current === null) out.push("no verified control root: ~/.agent-system-2/verified/current does not exist");
	else if (r.root !== r.current && !(dirname(r.root) === dirname(r.current)
		&& /\/\.agent-system-2\/verified\/[0-9a-f]{12}$/.test(r.root) && basename(r.root) === r.head.slice(0, 12))) {
		out.push(`root ${r.root} is not verified/current (${r.current})`);
	}
	if (mainVerdicts(mainResults(entries)).get(r.head)?.verdict !== "green") out.push(`HEAD ${r.head.slice(0, 12)} has no green believable main verdict`);
	if (r.modified.length > 0) out.push(`tracked files modified: ${r.modified.join(", ")}`);
	return out;
}
