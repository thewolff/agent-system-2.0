// The merge-train workload kind (PLAN wl-mv8s8srodefytc rev 17.1 § 1, part 1): Jo's `train <N> [<N> …]` opens a
// workload that takes green PRs one at a time, merges main in without rebasing, lets the resolver
// (surface/scripts/merge-train.ts) fix the conflicts it knows, runs the full suite, then merges a normal-stakes PR
// itself and asks Jo about a production-stakes one; a PR it cannot land goes back to its owner as a task (part 2).
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
import { parseReviewLoopEnd, parseReviewRound } from "../../classifier/src/rounds";
import {
	type ControlEntry, controlEntries, doneBecause, doneBody, heldLive, holdersOf, JO_HOLDER, launchRequestedBody, type OwnerTrainTask, PLAN_AUTO_STARTED, parseTrainBoard, parseTrainFix,
	planFirst, prBindingInstructionBody, prBindings, supersededBy, type TrainBinding, trainBindings, trainBoardBody, type TrainFix, trainFixBody,
} from "./launch";
import { CLASSIFIER_BY, type EntryRow, type InstructionRow, type Ledger, type MessageRow, newId, type QuestionRow, type Stakes, type WorkloadStatusRow } from "../../ledger/src/index";
import { askJo, raisedId } from "../../gates/src/rulings";
import { canonicalPath } from "../../ledger/src/locality";
import { incidentsOn } from "./incident";
import { DEFAULT_BRANCH } from "./merge-train-stack";
import { laneEnd, RELAUNCH_INCIDENT } from "./relaunch";
import { NOTICE_PREFIX } from "./notice";
import { ownerRepoOf, pushDestBody, SETTLING_VERDICTS, SHA_RE, type TestRunnerConfig, testRuns } from "./test-run";
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
 * `--match-head-commit`, verify, record) and a production PR gets Jo's question while the train goes on. A moved head goes
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
			"contains origin/main, `check` exits 0, and its last full suite at that head is green → step 7.",
		"3. `git merge --no-ff origin/main` (a merge commit). Never rebase, never force-push.",
		`4. On conflict: \`${RESOLVE_COMMAND} resolve --pr <n> --workload <head workload>\`, where <head workload> is the head branch's ` +
			"workload id when the branch is `wl/<wl-…>`, else `none`. Exit 0: it wrote and staged MIGRATION.md / migration/items / " +
			"install/manifest.tsv; `git commit --no-edit`. Exit 3 (a conflict outside that set), 4 (one it cannot fix without losing " +
			"a side's edit) or 2 (a usage error or a git process failure, e.g. `git merge-file` crashed): `git merge --abort`, push nothing, " +
			"and return the PR with kind `conflict` (the files, the resolver's exit code and its message). The train never resolves a conflict by hand.",
		`5. Conversion commit: \`${RESOLVE_COMMAND} convert --pr <n> --workload <head workload> --base origin/main\`. When it wrote ` +
			"files, `git add` them and commit `migration: #<n>'s item to migration/items/<slug>.md`. Then `check` must exit 0, and " +
			"`git status --porcelain` must be empty.",
		"6. Declare the slice artifact (a bare `bun test <the PR's changed test files> surface/test/migration-items.test.ts`), pass it " +
			`on that clean tree, then \`${TRAIN_PUSH}\` (no force) in a bash call of its own from the PR worktree (its cwd, or a leading \`cd\`). Use the PR's open \`${full}\`, or add the next r when ` +
			`none is open. Then \`lane_full_test { pr: <n>, slice: ${full} }\`; a green or a \`red-main\` completes that slice itself. Green → step 7. ` +
			"`red-main` (every failing test also fails in the runner's run of main's base, so the PR adds none; the result names base's sha): " +
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
			"mergeable), and `git merge-base --is-ancestor origin/main <head>` must exit 0. A moved head (not the tested sha) → back to " +
			"step 2 (a new PR worktree at the new head, and on from there); never merge main into the older local tree. The tested " +
			"head not containing origin/main, or not `MERGEABLE` → back to step 3 (merge main in, push, a new suite run).",
		`   b. Stakes, again: run step 1's \`${RESOLVE_COMMAND} stakes --hold-ok\` command now, just before the merge; its answer decides, not step ` +
			"1's (the workload's stakes, its plan's hold or main's protection may have changed while the suite ran). `normal` → c. " +
			`\`${HOLD_PREFIX} (<gap>)\`, or a second exit 2 → record step 1's \`train-error:\` and pass the PR over, no question and no merge. ` +
			"`production: <reason>` → Production stakes, below. `hold: <reason> until <time|jo>` → no merge and no " +
			"question: lane_record_entry `train-hold: pr <n> head <the head a. read, all 40 hex> until <the line's own time or jo>`, leave " +
			"the PR's slices open (it is not terminal) and go on to the next PR; the tick wakes the train once the hold ends, and that pass works the PR from step 1.",
		"   c. Merge: `gh pr merge <n> -R <owner/repo> --merge --match-head-commit <head>`, a merge commit, never `--admin`, `--squash`, " +
			"`--rebase` or `--auto`. Main's protection, which b. verified (a strict rule requiring `as2/full-suite`, which the test runner " +
			"posts, in a ruleset the merging account can never bypass), makes GitHub refuse a merge whose head lacks the current main or a green status, so a race ends in a refused merge.",
		"   d. Verify: `gh pr view <n> -R <owner/repo> --json state,mergeCommit` shows `MERGED`. A refused merge (gh exits non-zero, or the " +
			"state is not MERGED) → back to a. once; a second refusal on the same head: lane_record_entry `train-error: pr <n> merge-refused " +
			"<gh's messages>` and pass the PR over (the tick retries it).",
		`   e. Record: complete \`${sl}\` with artifact \`merged by train <merge commit sha> (run <id>)\`, then the next PR.`,
		`   Production stakes, reached only from b. after a. passed: raise the question on \`${sl}\`: PR green and mergeable at <the ` +
			"head a. read> on main <the origin/main a. fetched>, run <the green run at that head>, <pass>/<fail>/<skip>, b.'s stakes " +
			"reason, the chain, item file if any; options merged / skip / stop. Do not wait for it: go on to the next PR while it is " +
			`open. merged → \`gh pr view\` shows MERGED, complete \`${sl}\` with artifact \`merged by Jo <merge commit>\`; skip → Jo's ` +
			"answer cancels the PR's open train slices; stop → record it and release the lane with no done-because (slices stay open, " +
			`the workload stays open; Jo's ${append} relaunches it).`,
		"",
		`Returning a PR to its owner (no question to Jo): write the detail to a file under \`$AS2_SCRATCH\`, then \`${LANE_TRAIN_RETURN_TOOL} ` +
			"{ pr: <n>, kind: red | conflict | stack, detail: <absolute path of the detail file> }`. It records the task on this workload " +
			"(`train-task:`, with the PR's owner and its attempt); the train tick delivers it to the owner and settles it. Then the next PR. A " +
			"returned PR's slices stay open, and a PR with an unsettled task is not worked again: its owner is on it. Once the task is settled " +
			"(`train-task-settled:`), the train's next pass works the PR from step 1 at its current head: green → merge; red, conflict or " +
			`stack → return it again (the tool sets the next attempt). When ${LANE_TRAIN_RETURN_TOOL} refuses because attempt 2 settled failed, pass the ` +
			"PR over: the tick raises Jo's alert. A PR passed over with `train-error:` is worked again on a later pass.",
		"Rules: one live run per workload; no code edit beyond the resolver's output; merge only at step 7 c., on b.'s `normal`, as a " +
			"merge commit; a production PR's merge is Jo's; a held PR is never merged while its hold stands. Record per PR with lane_record_entry: stakes and reason, head tested, run id, " +
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

/** The open workloads carrying an entry by `by` whose body starts with `prefix`, oldest first. */
function openWithEntry(ledger: Ledger, by: string, prefix: string): string[] {
	return ledger.db.query<{ id: string }, [string, string]>(
		`SELECT w.id AS id FROM workloads w WHERE w.status = 'open' AND EXISTS (
		   SELECT 1 FROM entries e WHERE e.workload_id = w.id AND e.kind = 'assumption' AND e.created_by = ?1 AND substr(e.body, 1, length(?2)) = ?2)
		 ORDER BY w.created_at, w.id`,
	).all(by, prefix).map((r: { id: string }) => r.id);
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

/** One `train-fix:` on an open fix workload. */
export interface FixBinding extends TrainFix {
	workloadId: string;
	entryId: string;
}

/** Every `train-fix:` on an open workload (the tick's, MERGE_TRAIN_BY), oldest workload first. */
export function fixBindings(ledger: Ledger): FixBinding[] {
	return openWithEntry(ledger, MERGE_TRAIN_BY, "train-fix:").flatMap((wl) =>
		controlEntries(ledger.entries(wl)).flatMap((c) => {
			const f = c.prefix === "train-fix" ? parseTrainFix(c.rest) : null;
			return f ? [{ ...f, workloadId: wl, entryId: c.id }] : [];
		}));
}

/**
 * The workloads that own task `t`: its D1 owner, and every fix workload bound to its train and PR (owner none, or an owner closed
 * since). A fix binding counts only when its `train-entry` is a membership entry on that train listing the PR (`trainBindings`), as `boundPrs` rules.
 */
function taskOwners(ledger: Ledger, t: TrainTask, fixes: readonly FixBinding[]): string[] {
	const out = t.owner === null ? [] : [t.owner];
	for (const f of fixes) {
		if (f.train !== t.train || f.pr !== t.pr || out.includes(f.workloadId)) continue;
		if (trainBindings(ledger.entries(f.train), ledger.instructions(f.train)).some((b) => b.entryId === f.trainEntry && b.prs.includes(f.pr))) out.push(f.workloadId);
	}
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

/**
 * What the tick knows from GitHub when it settles: each PR's current head (`gh pr view <n> --json headRefOid`), and the pushes
 * to its head branch (`trainActivityArgs`). A PR missing from `heads` cannot settle fixed this pass; one missing from `pushes`
 * (the listing failed or was unreadable) has no push evidence this pass, so no push-based rule settles it.
 */
export interface SettleFacts {
	train: string;
	heads: ReadonlyMap<number, string>;
	pushes: ReadonlyMap<number, readonly TrainPush[]>;
}

interface SettleEvent {
	at: string;
	outcome: TaskSettle["outcome"];
	evidence: string;
}

/** A stretch in which an owner's relaunch incident holds a task's no-push rule (§ 1.7): from the incident to Jo's word launch, or open. */
interface IncidentHold {
	from: string;
	to: string | null;
}

/**
 * The holds owner `o`'s relaunch incidents put on a task created at `t0` (PLAN wl-mvfqvd5hy8zv28 § 1.7): each `incident: relaunch`
 * message the surface wrote on `o` holds from its creation to the first `launch-requested: by jo` on `o` after it, or stays
 * open while there is none. An incident written before the task holds it too while it still stands at t0 (review r1 m6): the
 * owner is as dead for the new task as for the old one. One that Jo's word ended by t0 holds nothing. `control` is `o`'s
 * control entries, oldest first.
 */
function incidentHolds(ledger: Ledger, o: string, control: readonly ControlEntry[], t0: string): IncidentHold[] {
	const joWords = control.filter((c) => c.prefix === "launch-requested" && c.createdBy === SURFACE_BY && /^by jo(?:\s|$)/.test(c.rest)).map((c) => c.createdAt);
	return incidentsOn(ledger, SURFACE_BY, RELAUNCH_INCIDENT, o)
		.map((i) => ({ from: i.createdAt, to: joWords.find((at) => at > i.createdAt) ?? null }))
		.filter((h) => h.to === null || h.to > t0);
}

/**
 * Task `t`'s first terminal event among its owners' rows, or null while none has happened (D8). `pushes` is GitHub's record of
 * pushes to the PR's head branch (`SettleFacts.pushes`), undefined when this pass could not read it.
 */
function settleEvent(ledger: Ledger, t: TrainTask, owners: readonly string[], head: string | null, pushes: readonly TrainPush[] | undefined, now: string): SettleEvent | null {
	const t0 = t.createdAt;
	const events: SettleEvent[] = [];
	// The first runner result requested after t0 that is not an error decides; stale and superseded runs settle nothing either.
	// A green (or red-main) decides only at a head other than H0 that is the PR's current head; until then the next result is read.
	const runs = owners.flatMap((o) => testRuns(ledger.entries(o)).filter((r) => r.request.pr === t.pr && r.request.createdAt > t0))
		.sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
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
	const holds: IncidentHold[] = [];
	for (const o of owners) {
		const entries = ledger.entries(o);
		const w = ledger.workload(o);
		const holders = holdersOf(entries, w?.holder ?? null, ledger.holders(o));
		const gaveUp = entries.find((e) => e.kind === "assumption" && holders.includes(e.created_by) && failedBody.test(e.body.trim()));
		if (gaveUp) events.push({ at: gaveUp.created_at, outcome: "failed", evidence: `owner ${o} wrote ${gaveUp.id}: ${gaveUp.body.trim()}` });
		const control = controlEntries(entries, holders);
		// PLAN wl-mvfqvd5hy8zv28 § 1.7: an owner lane that died by § 1.1 (`laneEnd`: an unintended outcome, a stop on signal; never
		// when Jo or the ceiling stopped it) is the relaunch's to retry, not a train attempt, so its exit settles nothing and the task
		// stays the owner's; an intended exit with no push since the task still fails it. The exit itself says the lane is over, so
		// the reading ignores whoever holds the workload now (a relaunched successor's live lease included).
		const ended = control.filter((c) => c.prefix === "lane-exit" && c.createdAt > t0
			&& !(w !== null && laneEnd({ ...w, holder: null, holder_lease_until: null }, control, c.laneId!, now).kind === "died"));
		exits.push(...ended.map((c) => c.createdAt));
		const exit = since === null ? undefined : ended.find((c) => !since.some((p) => p <= c.createdAt));
		if (exit) events.push({ at: exit.createdAt, outcome: "failed", evidence: `lane ${exit.laneId} on ${o} exited (${exit.rest}) with no push since the task` });
		holds.push(...incidentHolds(ledger, o, control, t0));
	}
	// The first stretch of 2 h with no push fails the task at its 2 h mark, even when a later push came: a tick that ran late does
	// not erase a deadline that passed. A stretch starts at t0, at a push, or at Jo's word launch that ends an incident hold
	// (§ 1.7), and ends at the next push, the next incident, or now; no stretch runs inside a hold, so the deaths the incident
	// reports never fail the task.
	if (since !== null) {
		const stops = [...since, ...holds.map((h) => h.from)];
		const starts = [t0, ...since, ...holds.flatMap((h) => (h.to === null ? [] : [h.to]))]
			.filter((s) => !holds.some((h) => h.from <= s && (h.to === null || s < h.to))).sort();
		for (const s of starts) {
			const quiet = new Date(Date.parse(s) + TRAIN_NO_PUSH_MS).toISOString();
			if (quiet <= [now, ...stops.filter((p) => p > s)].sort()[0]!) {
				events.push({ at: quiet, outcome: "failed", evidence: `no push for 2 h since ${s}` });
				break;
			}
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
 * head other than H0 that is the PR's current head. failed: that result is red; the owner's holder wrote
 * `train-task-failed: <id>`; an owner lane exited as intended with no push before it; or some stretch of 2 h with no push had
 * passed. An owner lane that died (PLAN wl-mvfqvd5hy8zv28 § 1.7) settles nothing: the relaunch retries it with the same task, and
 * while a relaunch incident on an owner stands (until Jo's word launch) no 2 h stretch runs. A push
 * is one GitHub records on the head branch (`facts.pushes`, at GitHub's time), never a runner request or row 8's `push-dest:`;
 * with no record this pass, or one that does not name the PR's current head, the two push rules wait. An `error` result never
 * settles and is never an attempt. A settled task is never settled again.
 */
export function settleTasks(ledger: Ledger, facts: SettleFacts, now: string): string[] {
	const fixes = fixBindings(ledger);
	return unsettledTasks(ledger, facts.train).flatMap((t) => {
		const e = settleEvent(ledger, t, taskOwners(ledger, t, fixes), facts.heads.get(t.pr) ?? null, facts.pushes.get(t.pr), now);
		return e ? [trainTaskSettledBody(t.id, e.outcome, e.evidence)] : [];
	});
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
 * Why the tick wakes train `wl` (D10 step 1), or empty when nothing is actionable: a `train:` entry (the open, or Jo's append),
 * a `train-board:` (`#n boarded`, PLAN wl-mvbjiettjrfpxc D3)
 * or a task settle written after the train's last lane exit, a PR no lane has given its disposition slice since one exited,
 * a PR among `mergedDeps` (PRs whose dependency the tick saw merge on GitHub since the last pass), or Jo's answer to (or
 * withdrawal of) the tick's own alert question (D9) after the last exit: no lane raised that question, so no resume follows it.
 * After a lane exit, also every PR `trainRetries` lists: a passed-over PR whose retry is due, and a head the train has not seen;
 * a PR in `heldPassOvers` (passed over for main's protection while its episode is open, PLAN wl-mvbjiettjrfpxc D6) waits instead;
 * and every held PR whose hold has ended (`expiredHolds`, `hold-expired`; `stakesOf` is the tick's current `prStakes`).
 */
export function actionable(
	ledger: Ledger, wl: string, mergedDeps: readonly number[] = [], heads: ReadonlyMap<number, string> = new Map(), heldPassOvers: ReadonlySet<number> = new Set(),
	stakesOf: (pr: number) => PrStakes | null = () => null,
): string[] {
	const control = controlOf(ledger, wl);
	const exit = control.filter((c) => c.prefix === "lane-exit").at(-1) ?? null;
	const lastExit = exit?.createdAt ?? null;
	const after = (at: string) => lastExit === null || at > lastExit;
	const entries = ledger.entries(wl);
	const instructions = ledger.instructions(wl);
	const out: string[] = [];
	for (const b of trainBindings(entries, instructions)) {
		if (!after(b.createdAt)) continue;
		out.push(b.source === "board" ? `#${b.prs[0]} boarded` : `train: ${b.prs.map((n) => `#${n}`).join(" ")} (${b.entryId})`);
	}
	const tasks = parseTrainTasks(wl, control);
	const settles = taskSettles(control);
	for (const s of settles.values()) {
		if (after(s.createdAt)) out.push(`task ${s.taskId} on #${tasks.find((t) => t.id === s.taskId)?.pr ?? "?"} settled ${s.outcome}`);
	}
	const prs = trainPrs(entries, instructions);
	if (exit !== null) {
		const slices = new Set(ledger.slices(wl).map((s) => s.id));
		for (const n of prs) if (!slices.has(trainSliceId(wl, n))) out.push(`#${n} not yet worked`);
		const r = trainRetries(ledger, wl, heads);
		for (const p of r.passedOver) if (!heldPassOvers.has(p.pr)) out.push(`#${p.pr} passed over ${p.count}x (train-error:), retry due`);
		for (const h of r.untested) out.push(`#${h.pr} head ${h.sha} untested by the train${h.woken > 0 ? ` after ${h.woken} wake(s), retry due` : ""}`);
		for (const h of expiredHolds(ledger, wl, stakesOf)) out.push(`#${h.pr} hold-expired (${h.holdId})`);
	}
	for (const n of mergedDeps) if (prs.includes(n)) out.push(`#${n}'s dependency merged`);
	for (const q of ledger.questions(wl)) {
		const n = q.created_by === MERGE_TRAIN_BY && q.state !== "open" ? trainSlicePr(q.slice_id, wl) : null;
		if (n !== null && after(q.changed_at)) out.push(`alert ${q.id} on #${n} ${q.state}`);
	}
	return out;
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

/** The train PRs whose unsettled task workload `wl` holds (`ownerTasks`), ascending: what a relaunch incident on `wl` names (PLAN wl-mvfqvd5hy8zv28 § 1.7). */
export function heldTrainPrs(ledger: Ledger, wl: string): number[] {
	return [...new Set(ownerTasks(ledger, wl).map((t) => t.pr))].sort((a, b) => a - b);
}

/** `train #<n> held, …` for `heldTrainPrs`' list, the incident detail's part (PLAN wl-mvfqvd5hy8zv28 § 1.7); empty for none. */
export function trainHeldDetail(prs: readonly number[]): string {
	return prs.map((n) => `train #${n} held`).join(", ");
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
	/** `failed twice` (the tick's retry / skip / stop) or `production merge` (the lane's merged / skip / stop). */
	reason: string;
	record: AlertRecord;
}

export function trainAlertReason(options: readonly string[]): string {
	return options.includes("retry") ? "failed twice" : options.includes("merged") ? "production merge" : "question";
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

/** D1: a workload closed longer ago than this is no longer scanned (the scan stays bounded). */
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
	| { ready: true; workloadId: string; pr: number; sha: string; run: string; review: string; checkout: string; repo: string; closedAt: string }
	| { ready: false; workloadId: string; pr: number | null; sha: string | null; reason: string };

/** What `landingReady` reads beyond the ledger: the test runner's config, and how a checkout names its GitHub repository (git; injected in tests). */
export interface LandingContext {
	config: Pick<TestRunnerConfig, "repos">;
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
 * D1's ledger half for workload `wl`: ready when W is closed (within AUTOBOARD_WINDOW_MS), autonomous, at normal stakes, neither
 * the standing workload nor a merge train nor a fix workload (`isTrainOrFix`), not superseded (`supersededBy`) and not cancelled
 * (a `plan: first` never approved), on a repository the test runner serves; its holder's `done-because:` stands (`doneBecause`)
 * and is newer than the tick's `train-autoboard:` cutover; the newest full-suite run (`testRuns`) names PR n and is green at sha G;
 * and the review rule holds (`reviewPassed`). Otherwise the first failing rule, as a reason. The tick adds the live half (gh).
 */
export function landingReady(ledger: Ledger, wl: string, ctx: LandingContext): Landing {
	let pr: number | null = null;
	let sha: string | null = null;
	const no = (reason: string): Landing => ({ ready: false, workloadId: wl, pr, sha, reason });
	const w = ledger.workload(wl);
	if (!w) return no("no such workload");
	if (wl === STANDING_WORKLOAD_ID) return no("the standing workload");
	if (w.status !== "closed" || w.closed_at === null) return no("the workload is open");
	if (w.mode !== "autonomous") return no(`the workload is ${w.mode}`);
	if (w.stakes !== "normal") return no(`stakes ${w.stakes}`);
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
	if (doneBecause(entries, holders) === null) return no("no holder done-because");
	const receipt = entries.findLast((e) => e.kind === "assumption" && holders.includes(e.created_by) && e.body.trim().startsWith("done-because:"))!;
	const cutover = autoboardCutover(ledger);
	if (cutover === null) return no("no train-autoboard cutover yet");
	if (receipt.created_at <= cutover.createdAt) return no(`done-because ${receipt.id} predates the train-autoboard cutover ${cutover.entryId}`);
	if (Date.parse(ledger.now()) - Date.parse(w.closed_at) > AUTOBOARD_WINDOW_MS) return no("closed more than 14 days ago");
	if (newestRun === null) return no("no full-suite run");
	const result = newestRun.result;
	if (result === null) return no(`the newest run ${newestRun.request.runId} on #${pr} has no result`);
	if (result.verdict !== "green") return no(`the newest run ${newestRun.request.runId} on #${pr} is ${result.verdict}`);
	sha = result.sha;
	const review = reviewPassed(ledger, wl, entries, holders);
	if (!review.ok) return no(review.reason);
	return { ready: true, workloadId: wl, pr: pr!, sha: sha!, run: newestRun.request.runId, review: review.entryId, checkout, repo, closedAt: w.closed_at };
}

/** Every workload, open or closed, that ever carried a membership entry (`train:` or `train-board:`) and is a train, oldest first. */
function everyTrain(ledger: Ledger): string[] {
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
		if (!w || w.status !== "closed") return no(`${l.workloadId} is not closed`);
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

/** D1's scan: every workload closed within AUTOBOARD_WINDOW_MS, the standing one excepted, newest close first. */
export function autoboardCandidates(ledger: Ledger): string[] {
	const since = new Date(Date.parse(ledger.now()) - AUTOBOARD_WINDOW_MS).toISOString();
	return ledger.db.query<{ id: string }, [string, string]>(
		`SELECT id FROM workloads WHERE status = 'closed' AND closed_at >= ?1 AND id <> ?2 ORDER BY closed_at DESC, id DESC`,
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

/**
 * The PRs of train `wl`, not terminal, whose newest holder pass-over (`train-error: pr <n> …`) is for main's protection (D5's
 * `train-error: pr <n> protection <gap>`): D6 holds their backoff wake while the episode is open and wakes the train when it clears.
 */
export function protectionPassOvers(ledger: Ledger, wl: string): Set<number> {
	const entries = ledger.entries(wl);
	const holders = holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl));
	const newest = new Map<number, boolean>();
	for (const e of entries) {
		const p = e.kind === "assumption" && holders.includes(e.created_by) ? PASSED_OVER_RE.exec(e.body.trim()) : null;
		if (p) newest.set(Number(p[1]), PROTECTION_PASS_RE.test(e.body.trim()));
	}
	const out = new Set<number>();
	for (const [n, protection] of newest) {
		const sl = ledger.slice(trainSliceId(wl, n));
		if (protection && !(sl && (sl.state === "done" || sl.state === "cancelled"))) out.add(n);
	}
	return out;
}
