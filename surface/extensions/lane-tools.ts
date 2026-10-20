// The lane's ledger tools (DESIGN-lane-launcher.md decision 4, § 4 row "Lane ledger tools"): the
// eight writes a lane makes to its own workload, each through the ledger module as the lane
// (P-11 row 10), registered on every session and inert on the orchestrator. A bash CLI cannot do
// this from inside a lane — the M4b fence denies the SQLite write at the OS level — and the by-hand
// script did it from outside OMP; these tools are that script's writes, with the checks the file
// cannot make: the caller is the bound lane, it holds the workload under a live lease, and it has
// not released. Bodies opening with a reserved control prefix (surface/src/launch.ts § 5) are
// refused rather than interpreted, so a model-authored line can never read as machinery; the one
// exception is `done-because:` through `lane_record_entry` (decision 16, the holder's receipt).
// `lane_message` also refuses the pushed signal prefixes (surface/src/signals.ts): a false death or
// a false pass must not reach Jo. `lane_release` and `lane_handoff` are terminal: they set the lane
// row's released flag (surface/extensions/lane.ts markReleased), refuse every later lane tool, and
// end the session through `ctx.shutdown` (§ 7 item 6; host contract pinned in gates/src/host.ts).
// `lane_withdraw_reserved` closes a held `reserved-request` the lane has gone past (MIGRATION.md
// item 31): row 6 holds a reserved action on every run, so an approval admits no re-run.
// `lane_raise_question` also holds a plan question offering `approve` until another lab has reviewed
// the plan (PLAN wl-mupu0sx2o046io D8), read from the ledger with the classifier's own rule; then
// checks its body against the plan question's shape (PLAN wl-muq22rnjcfrrpc D7) and writes the
// holder's `plan-question:` entry in the question's transaction (D9 part two). While `plan: first`
// stands unapproved it refuses `approve` on any other slice, naming the plan slice and the ways out
// (PLAN wl-mv5i3lulwwbbi8 D4). The plan question's check also reads the plan file once, at raise time:
// its `## Requirements` section names each requirement's enforcer or says prompt-only, and the body's
// `prompt-only:` lines list exactly the prompt-only ids (PLAN wl-mv8vwb04cy18n4 D1-D3); questions
// already raised are never re-checked. Every question goes through Jo's standing rulings (gates/src/rulings.ts `askJo`,
// PLAN wl-mvfkv7llkp7nk0 § 1): one a ruling decides writes no question row, records the lane's `ruling-applied:` and
// returns what to do instead; a question whose every option is a `provider/model` id declares its `subject`.
// PLAN wl-mvg1vs0rhnu3gg § 1.0, § 3.5: `now` (one of NOW_CATEGORIES; any other word is refused, nothing written) skips the
// rulings and plan auto-start; a plan question carrying it still passes the review and shape checks. An ask repeating an
// open question on its slice (same body and options) goes to `askJo`, which returns the open id as reused (with a `now:`
// mark when the repeat carries `now`); `plan-question:` is written only on a new raise, carrying the sha256 of the plan file
// and the verdict file the raise checked. A plan repeat skips the plan checks only while both files still hash the same
// (fix round 1, F1); a changed file takes every check, which refuses it while the open question stands.
// MIGRATION.md item 40 (PLAN wl-muq1v31q5ly7ls D4, D6): `lane_release` writes `released-open:` in the
// release's own transaction when open or paused slices remain and no holder receipt stands, and the
// terminal pair refuses while a hand this lane spawned is unsettled (surface/src/turn-end.ts);
// `lane_record_entry` refuses the classifier's lines as well (`CLASSIFIER_MACHINERY_PREFIXES`: `hand-spawn:`,
// `review-round:`, the same-lab and Kimi-out lines `review-same-lab:`, `review-same-lab-rule:`, `provider-refused:`
// and the rest; PLAN wl-mv64rsqw2fcs1s D5, PLAN wl-mv5xay6bjp0268 § 2.6), so a lane cannot forge a settle or a round
// verdict, grant itself same-lab or manufacture Kimi-out evidence; and it refuses `ruling-applied:`, which only
// `askJo` writes, so a lane cannot claim a ruling decided a question it never asked.
// `lane_full_test` asks the test runner (MIGRATION.md item 24; PLAN wl-muraerdsgw7gn4 § 2.1, § 4) to
// run the suite outside the fence at a PR head: the lane names a PR and optionally an open slice,
// nothing else, and the installed starter does the rest. A slice the runner was asked to settle is
// never completed through `lane_complete_slice`.
// `lane_read_facts` is the one read: the repo's M8 facts with no budget (MIGRATION.md item 106; surface/src/facts.ts).
// `lane_train_return` is the merge train's way to hand a PR back to its owner (PLAN wl-mv8s8srodefytc rev 17.1 D6): the
// lane names the PR, the kind and a detail file; the tool reads the PR's head with gh and writes the train's `train-task:`
// (surface/src/merge-train.ts `recordTrainTask`), which no lane can write through `lane_record_entry`.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	builderLabs, isBuilder, isReviewRouting, labOf, parkQuestions, parseHandSpawn, parseReviewSameLabRule, settledTokens, spentGrants, withheldTokens,
} from "../../classifier/src/lab";
import { countRounds, parseReviewGroup, parseReviewLimit, parseReviewLoopEnd, parseReviewRound } from "../../classifier/src/rounds";
import {
	type AskResult, askJo, decidedText, installedReviewModel, isNowCategory, MODEL_SUBJECTS, type ModelSubject, NOW_CATEGORIES, type NowCategory, nowMarks, RULING_APPLIED_PREFIX,
	rulingActive, subjectProblem,
} from "../../gates/src/rulings";
import { gateSession } from "../../gates/src/session";
import { ledgerFacts, parseDeployRow, parseDeploySettledRow } from "../../gates/src/deploy-risk";
import type { EntryRow, HandoffResult, Ledger, QuestionRow, RoutingRow, WorkloadStatusRow } from "../../ledger/src/index";
import { repoOf } from "../src/decision-log";
import { reservedStates } from "../src/errors";
import { readFacts } from "../src/facts";
import {
	CLASSIFIER_MACHINERY_PREFIXES, type ControlEntry, controlEntries, doneBecause, heldLive, holdersOf, JO_HOLDER, PLAN_QUESTION_LINE_MAX, PLAN_QUESTION_SHAPE, PLAN_REQUIREMENTS_HEADING,
	PLAN_FILE_MAX_BYTES, PLAN_REQUIREMENTS_SHAPE, type PlanBinding, planAutoApprovedBody, planAutoStartNoticeBody, planFirst, planHalted, planQuestionBinding, planQuestionBody,
	planQuestionFiles, planQuestionProblem, planSlice, reservedPrefix,
} from "../src/launch";
import { checkoutOwnerRepo, recordTrainTask, TASK_VIEW_FIELDS, type TaskView, taskViewOf, TRAIN_DETAIL_MAX_BYTES, TRAIN_TASK_KINDS, type TrainTaskKind, trainPrs } from "../src/merge-train";
import { NOTICE_PREFIX, sendNotice } from "../src/notice";
import { PAIR_OPTION } from "../src/pair-suggest";
import { expandCallerHandles } from "../src/linked-api";
import { SECURITY_RED_PREFIX, testRuns } from "../src/test-run";
import { releasedOpenBody, sliceCounts, unsettledHands } from "../src/turn-end";
import {
	ARTIFACT_COMMAND_PREFIX, ARTIFACT_FAILED_PREFIX, ARTIFACT_PASSED_PREFIX, type Ctx, ESCALATION_BY, HOLD_HOURS, LANE_ADD_SLICE_TOOL, LANE_COMPLETE_SLICE_TOOL,
	LANE_DIED_PREFIX, LANE_FULL_TEST_TOOL, LANE_HANDOFF_TOOL, LANE_MESSAGE_TOOL, LANE_RAISE_QUESTION_TOOL, LANE_READ_FACTS_TOOL, LANE_RECORD_ENTRY_TOOL, LANE_RELEASE_TOOL,
	LANE_TRAIN_RETURN_TOOL, LANE_WITHDRAW_RESERVED_TOOL, ORCHESTRATOR_RECIPIENT, PROMPT_RESOLVED_PREFIX, PROMPT_WAIT_PREFIX, type SurfaceAPI, TEST_RUN_FAILED_PREFIX, type ToolResult,
} from "../src/types";
import { isReleased, markReleased } from "./lane";

/**
 * The installed starter (PLAN wl-muraerdsgw7gn4 § 2.1): this extension is loaded from the main
 * checkout, so its own directory names that checkout, as `LANE_SCRIPT` does (surface/src/launch.ts).
 */
export const TEST_RUNNER_SCRIPT = join(import.meta.dir, "..", "scripts", "test-runner.ts");
/** The starter is foreground and returns within this (§ 2.2: under 30 s). */
const STARTER_TIMEOUT_MS = 30_000;
/** The slice ids the runner records (surface/src/test-run.ts `test-requested:`); never an argv flag. */
const SLICE_ID_RE = /^sl-\S+$/;

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });

/** Message bodies the machinery writes and the surface reads as signals; a lane's own message must not open with one. */
const PUSHED_SIGNAL_PREFIXES = [LANE_DIED_PREFIX, PROMPT_WAIT_PREFIX, PROMPT_RESOLVED_PREFIX, ARTIFACT_FAILED_PREFIX, ARTIFACT_PASSED_PREFIX, TEST_RUN_FAILED_PREFIX, NOTICE_PREFIX, SECURITY_RED_PREFIX];

/** The slice kinds `lane_add_slice` takes; the routing kinds, so the plan slice is `judge` (SPEC § B6). */
const SLICE_KINDS = ["locate", "understand", "change-small", "change-large", "judge"] as const;


interface Owned {
	ledger: Ledger;
	workload: WorkloadStatusRow;
	laneId: string;
	workloadId: string;
}
type Ownership = { ok: true; own: Owned } | { ok: false; result: ToolResult };

/** D8's refusal: what the lane does instead. */
export const planReviewRefusal = (planId: string) =>
	`a plan goes to Jo only after a review by another lab: dispatch a review hand named ${planId} on the plan, then raise the question naming its verdict`;

/**
 * At most PLAN_FILE_MAX_BYTES + 1 bytes of the regular file at `p`, or null when it cannot be read. Non-blocking open, then a
 * regular-file check on the open descriptor: a path swapped for a FIFO after a stat neither blocks the surface nor is read.
 * The read is bounded whatever the file's size or growth (PLAN wl-mv8vwb04cy18n4 D3).
 */
function readBounded(p: string): Buffer | null {
	try {
		const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			if (!fstatSync(fd).isFile()) return null;
			const buf = Buffer.alloc(PLAN_FILE_MAX_BYTES + 1);
			let n = 0;
			while (n < buf.length) {
				const got = readSync(fd, buf, n, buf.length - n, n);
				if (got === 0) break;
				n += got;
			}
			return buf.subarray(0, n);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** The sha256 of the regular file at `p` when it holds at most PLAN_FILE_MAX_BYTES bytes; null otherwise. */
function fileSha(p: string): string | null {
	const b = readBounded(p);
	return b === null || b.length > PLAN_FILE_MAX_BYTES ? null : createHash("sha256").update(b).digest("hex");
}

/**
 * PLAN wl-mvg1vs0rhnu3gg fix round 1, F1: may a repeat of the open plan question `questionId` skip the plan checks? Only when a
 * holder's `plan-question:` entry binds it to the plan file's and the verdict file's sha256 and both files hash the same now.
 * An entry with no binding (one written before the fix), or a file changed, missing or over the bound, is not unchanged.
 */
function planUnchanged(control: readonly ControlEntry[], questionId: string, body: string): boolean {
	const bound = control.filter((c) => c.prefix === "plan-question").map((c) => planQuestionBinding(c.rest, questionId)).findLast((b) => b !== null) ?? null;
	const files = planQuestionFiles(body);
	if (bound === null || files === null) return false;
	return fileSha(files.plan) === bound.plan && fileSha(files.verdict) === bound.verdict;
}

/**
 * PLAN wl-mupu0sx2o046io D8: has the plan slice `planId` a review that clears a question offering
 * `approve`? A `routings` row that (1) is on the plan slice and is a review (D2 read-back); (2) ran,
 * its `hand-settled:` token has no `review-withheld:`, and every model that answered is on a lab
 * outside `builderLabs` computed now (no live set: an in-flight hand counts every lab of its row), or
 * its token ran same-lab (`sameLabTokens`: Jo's same-lab answer to a `review-park:` question of this
 * slice, or Jo's Kimi-out rule); (3) was created after the newest earlier question on the plan slice was
 * raised and resolved (an open one clears nothing). A `review-limit:` question Jo answered `accept`
 * does not reset (3) to its own resolution; when the newest one raised since that resolution
 * exists, the plan clears only on the rows of the round that hit its limit (check 2 still applying)
 * or on a review created after Jo's accept: an older round of that loop does not stand in for it.
 * A row with no `hand-settled:` token is not cleared: nothing proves it was not withheld.
 */
export function planReviewed(ledger: Ledger, workloadId: string, planId: string): boolean {
	const entries = ledger.entries(workloadId);
	const instructions = new Map(ledger.instructions(workloadId).map((i) => [i.id, i]));
	const limitAt = new Map<string, number>();
	entries.forEach((e, at) => {
		const limit = e.kind === "assumption" ? parseReviewLimit(e.body) : null;
		if (limit && limit.slice === planId && !limitAt.has(limit.questionId)) limitAt.set(limit.questionId, at);
	});
	const acceptedLimit = (q: QuestionRow) => {
		const a = q.state === "answered" && q.resolved_by !== null ? instructions.get(q.resolved_by) : undefined;
		return limitAt.has(q.id) && a?.kind === "answer" && a.author === JO_HOLDER && a.body.trim().toLowerCase() === "accept";
	};
	const questions = ledger.questions(workloadId).filter((q) => q.slice_id === planId);
	const last = questions.filter((q) => !acceptedLimit(q)).at(-1);
	if (last?.state === "open") return false;
	const since = last?.changed_at ?? "";
	const settled = settledTokens(entries);
	const tokenOf = new Map([...settled].map(([token, routing]) => [routing, token]));
	// D8 × D9: the rows of the round Jo accepted at its limit, the newest such question since `since`.
	const accepted = questions.filter((q) => acceptedLimit(q) && q.created_at > since).at(-1);
	const acceptedRows = new Set<string>();
	for (const m of accepted ? countRounds(entries.slice(0, limitAt.get(accepted.id)), planId).rounds.at(-1)?.members ?? [] : []) {
		const routing = settled.get(m.token);
		if (routing) acceptedRows.add(routing);
	}
	const fresh = accepted?.changed_at ?? since;
	const parks = parkQuestions(entries, planId);
	const granted = sameLabTokens(entries, planId, (grant) => {
		const i = instructions.get(grant);
		return i?.kind === "answer" && i.author === JO_HOLDER && i.question_id !== null && parks.has(i.question_id) && i.body === "same-lab";
	});
	const withheld = withheldTokens(entries);
	const builders = builderLabs(ledger, workloadId);
	return ledger.routings(workloadId).some((row) => {
		if (row.slice_id !== planId || !isReviewRouting(row) || row.outcome !== "ran") return false;
		const token = tokenOf.get(row.id);
		if (token === undefined || withheld.has(token)) return false;
		const ran = ranModels(row);
		const crossLab = ran.length > 0 && ran.every((m) => {
			const lab = labOf(m);
			return lab !== null && !isBuilder(builders, lab);
		});
		if (!crossLab && !granted.has(token)) return false;
		return row.created_at > fresh || acceptedRows.has(row.id);
	});
}

/** classifier/extension.ts `headroomSkipBody`: `headroom-skip: <selector> token <dt> <reason>`; group 1 is the token. */
const HEADROOM_SKIP = /^headroom-skip: \S+ token (\S+)(?: |$)/;

/**
 * PLAN wl-mv5xay6bjp0268 § 2.6 [r2-M1]: the review tokens on the plan slice `planId` that ran same-lab
 * by right. The entry that lets a token run is either a `review-same-lab: <grant> token <dt>` spend
 * whose grant `joGrant` accepts, or a `review-same-lab-rule: … slice <planId> token <dt> …` entry
 * (Jo's Kimi-out rule); it counts only when the next entry in the workload's order, past an unbroken
 * run of that token's `headroom-skip:` rows on the plan slice by the same writer (#228), is that
 * token's `hand-spawn:` on the plan slice by the same writer, what the classifier's `recordSpawn`
 * writes in one transaction. A spend or rule line standing alone, or followed by another writer's
 * spawn, clears nothing.
 */
function sameLabTokens(entries: readonly EntryRow[], planId: string, joGrant: (grant: string) => boolean): Set<string> {
	const out = new Set<string>();
	const mine = (x: EntryRow | undefined, e: EntryRow): x is EntryRow => x?.kind === "assumption" && x.created_by === e.created_by && x.slice_id === planId;
	entries.forEach((e, at) => {
		if (e.kind !== "assumption") return;
		const rule = parseReviewSameLabRule(e.body);
		const spend = rule ? undefined : [...spentGrants([e])][0];
		const token = rule ? (rule.slice === planId ? rule.token : null) : spend && joGrant(spend[0]) ? spend[1] : null;
		if (token === null) return;
		let n = at + 1;
		while (mine(entries[n], e) && HEADROOM_SKIP.exec(entries[n]!.body)?.[1] === token) n++;
		const next = entries[n];
		if (mine(next, e) && parseHandSpawn(next.body)?.token === token) out.add(token);
	});
	return out;
}

function ranModels(row: Pick<RoutingRow, "ran_models">): string[] {
	if (row.ran_models === null) return [];
	try {
		const list: unknown = JSON.parse(row.ran_models);
		return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
	} catch {
		return [];
	}
}

/**
 * PLAN wl-mvfkv7llkp7nk0 § 3: the dispatch group of the review round that lets the plan question on plan slice `planId`
 * start the plan with no question to Jo, or null when the question goes to Jo. The caller has checked that the question is
 * the plan question and its body is in shape ((c)). All of these hold:
 * (a) the workload's stakes are normal;
 * (b) the newest `review-loop-end:` on the plan slice is `reason pass`, and it is the latest review state: after it the
 *     slice has no `hand-spawn: … review yes`, `review-group:` or `review-round:` entry, and no review routing that is not
 *     a member of the round it closes. That round (`countRounds` over the entries before the loop-end) is the loop's
 *     newest, complete and passed, and every member's routing is a review on the plan slice that ran, has no
 *     `review-withheld:`, ran on no same-lab token (no `review-same-lab:` grant spend and no `review-same-lab-rule:` names
 *     it), was answered only by models on labs outside `builderLabs`, and was created after every question on the plan
 *     slice was resolved (none may be open). Jo's `accept` at a round limit ends the loop with `reason accept`, so it fails;
 * (d) no `plan: halted` on the workload, ever;
 * (e) Jo's `flow-repair` ruling is not active at `now` (ms since the epoch).
 */
export function planAutoStartRound(ledger: Ledger, workloadId: string, planId: string, now: number): string | null {
	if (ledger.workload(workloadId)?.stakes !== "normal" || rulingActive(ledger, "flow-repair", now)) return null;
	const entries = ledger.entries(workloadId);
	if (planHalted(controlEntries(entries))) return null;
	const endAt = entries.findLastIndex((e) => e.kind === "assumption" && parseReviewLoopEnd(e.body)?.slice === planId);
	if (endAt < 0 || parseReviewLoopEnd(entries[endAt]!.body)!.reason !== "pass") return null;
	const later = entries.slice(endAt + 1).some((e) => {
		if (e.kind !== "assumption") return false;
		const body = e.body.trim();
		return (e.slice_id === planId && parseHandSpawn(body)?.review === true) || parseReviewGroup(body)?.slice === planId || parseReviewRound(body)?.slice === planId;
	});
	if (later) return null;
	const round = countRounds(entries.slice(0, endAt), planId).rounds.at(-1);
	if (!round?.complete || !round.passed || round.members.length === 0) return null;
	const questions = ledger.questions(workloadId).filter((q) => q.slice_id === planId);
	if (questions.some((q) => q.state === "open")) return null;
	const since = questions.reduce((at, q) => (q.changed_at > at ? q.changed_at : at), "");
	const settled = settledTokens(entries);
	const withheld = withheldTokens(entries);
	const sameLab = new Set(spentGrants(entries).values());
	for (const e of entries) {
		const rule = e.kind === "assumption" ? parseReviewSameLabRule(e.body) : null;
		if (rule) sameLab.add(rule.token);
	}
	const routings = ledger.routings(workloadId);
	const builders = builderLabs(ledger, workloadId);
	const members = new Set<string>();
	for (const m of round.members) {
		const id = settled.get(m.token);
		const row = routings.find((r) => r.id === id);
		if (!m.spawned || !m.accepted || withheld.has(m.token) || sameLab.has(m.token) || row === undefined) return null;
		if (row.slice_id !== planId || !isReviewRouting(row) || row.outcome !== "ran" || row.created_at <= since) return null;
		const ran = ranModels(row);
		const crossLab = ran.length > 0 && ran.every((model) => {
			const lab = labOf(model);
			return lab !== null && !isBuilder(builders, lab);
		});
		if (!crossLab) return null;
		members.add(row.id);
	}
	const end = entries[endAt]!.created_at;
	if (routings.some((r) => r.slice_id === planId && isReviewRouting(r) && !members.has(r.id) && r.created_at >= end)) return null;
	return round.group;
}

export default function laneToolsRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;

	/** Every lane tool's gate: a bound lane, not released, whose workload is open and held by it under a live lease. */
	const owned = (ctx: Ctx, verb: string): Ownership => {
		const s = gateSession(ctx, env);
		if (!s.bound) return { ok: false, result: text(`This session is not a lane bound to a workload; nothing was ${verb}.`) };
		if (isReleased(ctx)) return { ok: false, result: text(`This lane released ${s.workloadId} (or handed it to Jo); its work is over and nothing was ${verb}.`) };
		const ledger = s.ledger();
		const w = ledger.workload(s.workloadId!);
		if (!w) return { ok: false, result: text(`No workload ${s.workloadId}; nothing was ${verb}.`) };
		if (w.status !== "open") return { ok: false, result: text(`Workload ${w.id} is ${w.status}; nothing was ${verb}.`) };
		if (w.holder !== s.laneId || !heldLive(w, ledger.now())) {
			const who = w.holder === null ? "nobody" : w.holder === s.laneId ? `${s.laneId} under a lapsed lease` : w.holder;
			return { ok: false, result: text(`Workload ${w.id} is held by ${who}, not by this lane (${s.laneId}) under a live lease; nothing was ${verb}.`) };
		}
		return { ok: true, own: { ledger, workload: w, laneId: s.laneId, workloadId: w.id } };
	};

	/** A slice on this lane's workload that is still open or paused, or the refusal. */
	const sliceOn = (own: Owned, slice: string, verb: string): { ok: true; state: string } | { ok: false; result: ToolResult } => {
		const row = own.ledger.slice(slice);
		if (!row || row.workload_id !== own.workloadId) return { ok: false, result: text(`Slice ${slice} is not on workload ${own.workloadId}; nothing was ${verb}.`) };
		if (row.state === "done" || row.state === "cancelled") return { ok: false, result: text(`Slice ${slice} is ${row.state}; nothing was ${verb}.`) };
		return { ok: true, state: row.state };
	};

	const reserved = (body: string, verb: string): ToolResult | null => {
		const p = reservedPrefix(body);
		return p === null ? null : text(`A body opening with \`${p}:\` is a reserved control line the machinery writes; nothing was ${verb}. Say it in plain words.`);
	};

	/** `test-run-failed:` is the runner's pushed signal (§ 4 item 7): no lane body opens with it. */
	const runnerSignal = (body: string, verb: string): ToolResult | null =>
		body.startsWith(TEST_RUN_FAILED_PREFIX) ? text(`A body opening with \`${TEST_RUN_FAILED_PREFIX}\` is the test runner's signal; a lane's words must not read as one. Nothing was ${verb}.`) : null;

	/** The terminal pair's shared ending: mark released, stop the renewal timer, end the session (ctx.shutdown is host contract, gates/src/host.ts HOST_MEMBERS). */
	const endSession = (ctx: Ctx): string => {
		markReleased(ctx);
		ctx.shutdown();
		return "This session is ending.";
	};

	/** D6: the terminal pair waits for every hand this lane spawned; the refusal when one has no settled result on the ledger. */
	const handsUnsettled = (own: Owned, verb: string): ToolResult | null => {
		const hands = unsettledHands(own.ledger, own.workloadId, own.laneId);
		if (hands.length === 0) return null;
		return text(`hand(s) ${hands.map((h) => h.token).join(", ")} you spawned are still unsettled; keep your turn alive until each result is delivered, then release. Nothing was ${verb}.`);
	};

	const deploysUnsettled = (own: Owned): void => {
		const facts = ledgerFacts(own.ledger);
		const settled = new Set(facts.rows("deploy-settled").flatMap((r) => {
			const s = parseDeploySettledRow(r.body);
			return s ? [s.id] : [];
		}));
		const pending = facts.rows("deploy").filter((r) => r.workloadId === own.workloadId).flatMap((r) => {
			const d = parseDeployRow(r.body);
			return d && !settled.has(d.id) ? [d.id] : [];
		});
		if (pending.length) throw new Error(`unsettled deploy ${pending.join(", ")}; run ${pending.map((id) => `as2 deploy settle ${id}`).join("; ")} first`);
	};

	pi.registerTool({
		name: LANE_ADD_SLICE_TOOL,
		loadMode: "essential",
		label: "Add Slice",
		description:
			"Add a slice to this lane's workload: what to do, the done condition (what is true when it is done), and the inputs it needs. " +
			"`kind` is the routing kind of the work; while the workload is plan-first (a `plan:` line in the brief) only a `judge` slice — the plan slice — is accepted until Jo approves the plan.",
		parameters: z.object({
			task: z.string().describe("What the slice does, one line."),
			doneCondition: z.string().describe("What is true when the slice is done; its runtime artifact proves it."),
			inputs: z.string().describe("What the slice needs to start (files, decisions, prior slices)."),
			kind: z.enum(SLICE_KINDS).optional().describe("The routing kind of the work: locate, understand, change-small, change-large, or judge (the plan slice)."),
			id: z.string().optional().describe("A slice id to use (sl-…); generated when omitted."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "added");
			if (!o.ok) return o.result;
			const task = String(params.task ?? "").trim();
			const doneCondition = String(params.doneCondition ?? "").trim();
			const inputs = String(params.inputs ?? "").trim();
			if (!task || !doneCondition || !inputs) return text("A slice names its task, its done condition and its inputs; nothing was added.");
			const kind = typeof params.kind === "string" ? params.kind : null;
			const { ledger, workloadId } = o.own;
			// Decision 15: while `plan: first` stands with no `plan: approved`, only the judge-kind plan slice may be added.
			const entries = ledger.entries(workloadId);
			const flag = planFirst(controlEntries(entries, holdersOf(entries, o.own.workload.holder)));
			if (flag !== null && kind !== "judge") {
				const plan = planSlice(ledger.slices(workloadId));
				const where = plan
					? `the plan slice is ${plan.id} (${plan.state}); close it by raising its question (lane_raise_question, options approve / revise / cancel) and wait for Jo's approve`
					: "add the plan slice first: a `judge` kind slice whose artifact is the plan, closed by lane_raise_question with options approve / revise / cancel";
				return text(`Workload ${workloadId} is plan-first (${flag.trigger}) and the plan is not approved: ${kind === null ? "a slice without `kind: \"judge\"`" : `a ${kind} slice`} is refused; ${where}. Nothing was added.`);
			}
			const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : undefined;
			const sliceId = ledger.addSlice({ by: o.own.laneId, workloadId, task, doneCondition, inputs, id });
			return text(`Added slice ${sliceId} to ${workloadId}${kind ? ` (${kind})` : ""}: ${task}`, { id: sliceId });
		},
	});

	pi.registerTool({
		name: LANE_COMPLETE_SLICE_TOOL,
		loadMode: "essential",
		label: "Complete Slice",
		description: "Close a slice of this lane's workload on its runtime artifact: the command output, file, or PR that proves the done condition.",
		parameters: z.object({
			slice: z.string().describe("The slice id (sl-…) on this lane's workload."),
			artifact: z.string().describe("The runtime artifact proving the done condition (a path, a URL, a command and its result)."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "completed");
			if (!o.ok) return o.result;
			const slice = String(params.slice ?? "").trim();
			const artifact = String(params.artifact ?? "").trim();
			if (!slice || !artifact) return text("Completion names a slice id and its artifact; nothing was completed.");
			const on = sliceOn(o.own, slice, "completed");
			if (!on.ok) return on.result;
			// § 4 item 5: a slice the runner was asked to settle is settled by the runner, never by hand.
			if (testRuns(o.own.ledger.entries(o.own.workloadId)).some((r) => r.request.slice === slice)) {
				return text(`the test runner settles ${slice}; call ${LANE_FULL_TEST_TOOL}. Nothing was completed.`);
			}
			o.own.ledger.completeSlice(slice, { by: o.own.laneId, artifact });
			return text(`Completed slice ${slice} on ${artifact}.`, { id: slice });
		},
	});

	pi.registerTool({
		name: LANE_RAISE_QUESTION_TOOL,
		loadMode: "essential",
		label: "Raise Question",
		description:
			"Ask Jo a question on a slice of this lane's workload; the slice pauses until Jo answers with one of the options (or withdraws). " +
			"The plan slice closes this way, options approve / revise / cancel, with a body that carries the plan short, one item per line, " +
			`each line at most ${PLAN_QUESTION_LINE_MAX} characters and nothing else: the plan file's absolute path; one \`- <slice id>: <what it does>\` line per slice; ` +
			"one `prompt-only: <R id>: <the requirement, and why no code reaches it>` line per requirement the plan file marks prompt-only, or exactly `prompt-only: none` when it marks none; " +
			"1 to 3 `tradeoff: <one line>` lines; one `review: <verdict>, <model>, <absolute path to the verdict file>` line. " +
			`The plan file carries one \`${PLAN_REQUIREMENTS_HEADING}\` section in this grammar:\n${PLAN_REQUIREMENTS_SHAPE}\n` +
			"A plan question offering approve is refused until a review hand named after the plan slice has reviewed the plan on another lab since the last question, and refused in any other shape. " +
			"Until the plan is approved, a question offering approve on any other slice is refused. " +
			"Jo's standing rulings are checked first: a question one of them already answers is not raised, and the tool returns the ruling and what to do instead. " +
			"When every option is a provider/model id, `subject` says what the model is for (lane-model or review-model); otherwise it is left out. " +
			`\`now\` (one of ${NOW_CATEGORIES.join(", ")}) puts the question before Jo at once, past every ruling and past plan auto-start: a credible data-integrity or security risk or an urgent incident, ` +
			"weakening a guard or crossing a boundary Jo stated, or an irreversible effect or money commitment the plan does not authorize. " +
			"Asking an open question again (same slice, body and options) returns its id and raises nothing new; with `now` it marks that question NOW. " +
			"A repeated plan question whose plan file or verdict file changed since it was raised takes every plan check again, which refuses it while the open one stands.",
		parameters: z.object({
			slice: z.string().describe("The slice id (sl-…) the question is about."),
			body: z.string().describe("The question, in plain words (the plan slice's approve question: the plan in the shape above)."),
			options: z.array(z.string()).describe("At least two answers Jo can give in one word each."),
			subject: z
				.enum(MODEL_SUBJECTS)
				.optional()
				.describe("Required when every option is a provider/model id: lane-model (the model a lane runs on) or review-model (the model a review runs on)."),
			now: z.enum(NOW_CATEGORIES).optional().describe("Only when Jo must hear it at once: the category of the now trigger."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const before = owned(ctx, "asked");
			if (!before.ok) return before.result;
			const slice = String(params.slice ?? "").trim();
			const body = await expandCallerHandles(String(params.body ?? "").trim(), pi, ctx);
			// Locating is async: use current ownership, not the lease/holder snapshot from before it.
			const o = owned(ctx, "asked");
			if (!o.ok) return o.result;
			const options = Array.isArray(params.options) ? params.options.map((x) => String(x).trim()).filter((x) => x.length > 0) : [];
			if (!slice || !body) return text("A question names a slice id and a body; nothing was asked.");
			if (new Set(options.map((x) => x.toLowerCase())).size < 2) return text("A question offers at least two distinct options Jo can answer with; nothing was asked.");
			// PLAN wl-mv67564rdkfvnk D9 (2): `pair` is offered only by the round-limit raise site, never by a lane.
			if (options.some((x) => x.toLowerCase() === PAIR_OPTION)) return text(`The option \`${PAIR_OPTION}\` is offered only by the round-limit question the machinery raises; nothing was asked.`);
			if (options.some((x) => /\s/.test(x))) return text("Each option is one word (Jo answers with it alone or as `<option> q-…`); nothing was asked.");
			const nowWord = typeof params.now === "string" && params.now.trim() !== "" ? params.now.trim() : null;
			if (nowWord !== null && !isNowCategory(nowWord)) return text(`\`now\` is one of ${NOW_CATEGORIES.join(", ")}, not ${nowWord}; nothing was asked.`);
			const now: NowCategory | null = nowWord;
			const refused = reserved(body, "asked") ?? runnerSignal(body, "asked");
			if (refused) return refused;
			const on = sliceOn(o.own, slice, "asked");
			if (!on.ok) return on.result;
			const { ledger, workloadId } = o.own;
			const subject = typeof params.subject === "string" && params.subject !== "" ? (params.subject as ModelSubject) : null;
			// PLAN wl-mvg1vs0rhnu3gg § 1.0 (review r3 F1): an ask repeating an open question on this slice, with the same body and
			// options, goes to askJo, which returns the open id as reused (askJo's own rule; a model-subject ask never repeats one).
			const optionsJson = JSON.stringify(options);
			const repeated = subject === null ? ledger.questions(workloadId).find((q) => q.state === "open" && q.slice_id === slice && q.body === body && q.options === optionsJson) : undefined;
			// A question offering approve on the plan slice while `plan: first` stands is the plan question: reviewed (D8), then in shape (D7).
			// Offering approve on any other slice then is refused (PLAN wl-mv5i3lulwwbbi8 D4): Jo's approve there would approve nothing.
			let plan = false;
			let control: ControlEntry[] = [];
			if (options.some((x) => x.toLowerCase() === "approve")) {
				const entries = ledger.entries(workloadId);
				control = controlEntries(entries, holdersOf(entries, o.own.workload.holder));
				const planSl = planFirst(control) !== null ? planSlice(ledger.slices(workloadId)) : null;
				if (planSl !== null && planSl.id !== slice) {
					return text(
						`plan: first stands and the plan is not approved, so only the plan slice ${planSl.id} (${planSl.state}) may offer approve; ` +
							`Jo's approve on ${slice} would approve nothing. Complete ${planSl.id} with ${LANE_COMPLETE_SLICE_TOOL} (the next open judge slice takes the plan role), ` +
							`or ask Jo to type \`cancel-slice ${planSl.id}\`, then raise the plan question there; or offer ${slice} options without approve. Nothing was asked.`,
					);
				}
				plan = planSl !== null;
			}
			// Fix round 1 (F1): a plan repeat skips the plan checks and auto-start only while the plan file and the verdict file hash
			// as they did when the open question was raised (`planUnchanged`); otherwise it takes every check, and planReviewed
			// refuses it while that question stands open.
			const skippedChecks = plan && repeated !== undefined && planUnchanged(control, repeated.id, body);
			let binding: PlanBinding | undefined;
			if (plan && !skippedChecks) {
				if (!planReviewed(ledger, workloadId, slice)) return text(`${planReviewRefusal(slice)}. Nothing was asked.`);
				// PLAN wl-mv8vwb04cy18n4 D3: the plan file is read here, once (`readBounded`); a file that cannot be read is null and
				// refused, and a plan over PLAN_FILE_MAX_BYTES is refused (planQuestionProblem) without the surface holding more of it.
				// The bytes judged are the bytes the question's binding hashes, so no edit between the check and the hash is bound.
				const judged: { plan: Buffer | null } = { plan: null };
				const readFile = (p: string): string | null => {
					judged.plan = readBounded(p);
					return judged.plan?.toString("utf8") ?? null;
				};
				const problem = planQuestionProblem(body, (p) => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false, readFile);
				if (problem !== null) {
					return text(
						`A plan question offering approve has this shape, one item per line, each line at most ${PLAN_QUESTION_LINE_MAX} characters, nothing else:\n${PLAN_QUESTION_SHAPE}\n` +
							`Its plan file carries one \`${PLAN_REQUIREMENTS_HEADING}\` section in this grammar:\n${PLAN_REQUIREMENTS_SHAPE}\nThis body does not: ${problem}. Nothing was asked.`,
					);
				}
				// Fix round 1 (F1): the plan file as judged and the verdict file now, bound to the question if it is raised.
				const verdict = fileSha(planQuestionFiles(body)?.verdict ?? "");
				if (judged.plan !== null && verdict !== null) binding = { plan: createHash("sha256").update(judged.plan).digest("hex"), verdict };
				// PLAN wl-mvfkv7llkp7nk0 § 3: a normal-stakes plan whose latest review round passed wholly cross-lab starts here,
				// with no question row: ESCALATION_BY's `plan: approved auto <group>` and Jo's notice, in one write that re-reads (a)–(e).
				// A plan question carrying `now` skips this and goes to Jo (PLAN wl-mvg1vs0rhnu3gg § 1.0, review r2 N1).
				const started = now !== null ? null : ledger.write(() => {
					const group = planAutoStartRound(ledger, workloadId, slice, Date.parse(ledger.now()));
					if (group === null) return null;
					ledger.recordEntry({ by: ESCALATION_BY, workloadId, sliceId: slice, kind: "assumption", body: planAutoApprovedBody(group) });
					sendNotice(ledger, { by: ESCALATION_BY, workloadId, body: planAutoStartNoticeBody(workloadId, body) });
					return group;
				});
				if (started !== null) {
					return text(
						`The plan is approved: its review round ${started} passed on labs other than the builder's at normal stakes, so it started without Jo's approve ` +
							`and no question was raised; Jo has a notice, and its PRs wait ${HOLD_HOURS} h after Jo's next message before the train merges them. ` +
							`Complete ${slice} with ${LANE_COMPLETE_SLICE_TOOL}, then add your change slices with ${LANE_ADD_SLICE_TOOL}.`,
						{ approved: "auto", group: started },
					);
				}
			}
			// D9 part two: the plan question's role is recorded as it is raised, by the holding lane, in the same write, with the
			// binding of its plan and verdict files (fix round 1, F1); a reused open question already has its entry (PLAN
			// wl-mvg1vs0rhnu3gg § 3.5). A plan repeat that skipped the plan checks and finds its open question resolved inside the
			// write is rolled back: a new plan question passes every check.
			// PLAN wl-mvfkv7llkp7nk0 § 1: the standing rulings are checked first; a decided question writes no question row.
			const subjectWrong = subjectProblem(options, subject);
			if (subjectWrong !== null) return text(`${subjectWrong}; nothing was asked.`);
			const resolvedMeanwhile = new Error("the repeated open question was resolved");
			let asked: AskResult;
			try {
				asked = ledger.write(() => {
					const r = askJo(
						ledger,
						{ by: o.own.laneId, workloadId, sliceId: slice, body, options, subject, now },
						{
							asker: "lane",
							builders: builderLabs(ledger, workloadId),
							stakes: o.own.workload.stakes,
							train: trainPrs(ledger.entries(workloadId), ledger.instructions(workloadId)).length > 0,
							reviewModel: () => installedReviewModel(env),
						},
					);
					if (skippedChecks && !("reused" in r)) throw resolvedMeanwhile;
					if (plan && "raised" in r && !("reused" in r)) ledger.recordEntry({ by: o.own.laneId, workloadId, sliceId: slice, kind: "assumption", body: planQuestionBody(r.raised, binding) });
					return r;
				});
			} catch (e) {
				if (e !== resolvedMeanwhile) throw e;
				return text(`The open question this repeats on ${slice} was resolved while you asked; nothing was asked. Raise the plan question again: a new one passes every plan check.`);
			}
			if ("decided" in asked) return text(`${decidedText(asked.decided)}.`, { ruling: asked.decided.ruling, answer: asked.decided.answer });
			const id = asked.raised;
			const mark = nowMarks(ledger.entries(workloadId, "assumption")).get(id) ?? null;
			const nowNote = mark === null ? "" : ` It reaches Jo at once, marked NOW (${mark}).`;
			if ("reused" in asked) {
				return text(`Question ${id} on ${slice} is already open with this body and options; nothing new was raised.${nowNote} The slice stays paused until Jo answers ${id}.`, { id, reused: true, now: mark });
			}
			return text(`Raised question ${id} on ${slice} (${options.join(" / ")}); the slice is paused until Jo answers.${nowNote}`, { id, now: mark });
		},
	});

	pi.registerTool({
		name: LANE_RECORD_ENTRY_TOOL,
		loadMode: "essential",
		label: "Record Entry",
		description:
			"Record an assumption or a decision on this lane's workload as a ledger entry, optionally on a slice. " +
			"When the workload is done, record its receipt as `done-because: <what is true now, against the workload's done: line>`; the orchestrator's close needs it.",
		parameters: z.object({
			body: z.string().describe("The entry, one paragraph; `done-because: …` for the workload's completion receipt."),
			slice: z.string().optional().describe("The slice id (sl-…) the entry is about, when it is about one."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const before = owned(ctx, "recorded");
			if (!before.ok) return before.result;
			const body = await expandCallerHandles(String(params.body ?? "").trim(), pi, ctx);
			const o = owned(ctx, "recorded");
			if (!o.ok) return o.result;
			if (!body) return text("An entry has a body; nothing was recorded.");
			const prefix = reservedPrefix(body);
			if (prefix !== null && prefix !== "done-because") return reserved(body, "recorded")!;
			if (body.startsWith(ARTIFACT_COMMAND_PREFIX)) return text(`A slice's artifact command is declared with slice_artifact, not written as an entry; nothing was recorded.`);
			const machinery = /^([a-z-]+):/.exec(body)?.[1];
			if (machinery !== undefined && (CLASSIFIER_MACHINERY_PREFIXES as readonly string[]).includes(machinery)) {
				return text(`A body opening with \`${machinery}:\` is a reserved control line the classifier writes; nothing was recorded. Say it in plain words.`);
			}
			if (machinery === RULING_APPLIED_PREFIX) {
				return text(`A body opening with \`${RULING_APPLIED_PREFIX}:\` is written only when a standing ruling decides a raised question; nothing was recorded. Say it in plain words.`);
			}
			const signal = runnerSignal(body, "recorded");
			if (signal) return signal;
			const slice = typeof params.slice === "string" && params.slice.trim() ? params.slice.trim() : null;
			if (slice !== null) {
				const row = o.own.ledger.slice(slice);
				if (!row || row.workload_id !== o.own.workloadId) return text(`Slice ${slice} is not on workload ${o.own.workloadId}; nothing was recorded.`);
			}
			const id = o.own.ledger.recordEntry({ by: o.own.laneId, workloadId: o.own.workloadId, sliceId: slice, kind: "assumption", body });
			const receipt = prefix === "done-because" ? " This is the workload's completion receipt; the orchestrator can close it once you release." : "";
			return text(`Recorded entry ${id} on ${o.own.workloadId}${slice ? ` (${slice})` : ""}.${receipt}`, { id });
		},
	});

	pi.registerTool({
		name: LANE_MESSAGE_TOOL,
		loadMode: "essential",
		label: "Message Orchestrator",
		description: "Send one message to the orchestrator about this lane's workload (a finding, a blocker, a QUESTION that needs Jo). It reaches Jo's surface at its next read.",
		parameters: z.object({
			body: z.string().describe("The message, in plain words."),
			slice: z.string().optional().describe("The slice id (sl-…) it is about, when it is about one."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const before = owned(ctx, "sent");
			if (!before.ok) return before.result;
			const body = await expandCallerHandles(String(params.body ?? "").trim(), pi, ctx);
			const o = owned(ctx, "sent");
			if (!o.ok) return o.result;
			if (!body) return text("A message has a body; nothing was sent.");
			const refused = reserved(body, "sent");
			if (refused) return refused;
			const signal = PUSHED_SIGNAL_PREFIXES.find((p) => body.startsWith(p));
			if (signal) return text(`A message opening with \`${signal}\` is a signal the machinery pushes to Jo; a lane's words must not read as one. Nothing was sent.`);
			const slice = typeof params.slice === "string" && params.slice.trim() ? params.slice.trim() : null;
			if (slice !== null) {
				const row = o.own.ledger.slice(slice);
				if (!row || row.workload_id !== o.own.workloadId) return text(`Slice ${slice} is not on workload ${o.own.workloadId}; nothing was sent.`);
			}
			const id = o.own.ledger.enqueue({ by: o.own.laneId, workloadId: o.own.workloadId, sliceId: slice, sender: o.own.laneId, recipient: ORCHESTRATOR_RECIPIENT, body });
			return text(`Sent message ${id} to the orchestrator.`, { id });
		},
	});

	pi.registerTool({
		name: LANE_WITHDRAW_RESERVED_TOOL,
		loadMode: "essential",
		label: "Withdraw Reserved Request",
		description:
			"Withdraw a reserved request (P-11 row 6's `reserved-request` entry) on this lane's workload that is still waiting on Jo, once this lane has gone past it. " +
			"Approval never admits a re-run (row 6 holds a reserved action every time), so this is how the lane says it no longer needs it.",
		parameters: z.object({
			id: z.string().describe("The reserved-request entry id (en-…) on this lane's workload."),
			reason: z.string().optional().describe("Why, in a few words (e.g. 'went another way'); shown in the decision log."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "withdrawn");
			if (!o.ok) return o.result;
			const id = String(params.id ?? "").trim();
			if (!id) return text("A withdrawal names the reserved-request entry id; nothing was withdrawn.");
			const reason = typeof params.reason === "string" ? params.reason.replace(/\s+/g, " ").trim() : "";
			const r = reservedStates(o.own.ledger, o.own.workloadId).find((x) => x.id === id);
			if (!r) return text(`${id} is not a reserved request on workload ${o.own.workloadId}; nothing was withdrawn.`);
			if (r.state.kind !== "waiting") return text(`Reserved request ${id} is not waiting on Jo (it is ${r.state.kind}); nothing was withdrawn.`);
			const entry = o.own.ledger.recordEntry({ by: o.own.laneId, workloadId: o.own.workloadId, kind: "assumption", body: `reserved-withdrawn: ${id}${reason ? ` ${reason}` : ""}` });
			return text(`Withdrew reserved request ${id} (entry ${entry}); it no longer waits on Jo.`, { id: entry });
		},
	});

	pi.registerTool({
		name: LANE_FULL_TEST_TOOL,
		loadMode: "essential",
		label: "Run Full Test Suite",
		description:
			"Run this workload's full test suite outside the fence at an open PR's head, then each changed test file alone. Call it after the last push, with the PR number; it returns the run's line at once and the result arrives later as an aside (verdict, counts, failures). " +
			"Without `slice` the runner adds the full-suite slice; with it, the slice must be open on this workload. A green completes that slice; a red, stale or error leaves it open: fix, push, and call again with the slice. " +
			"Never complete that slice yourself. While a run is live, work on something else or `sleep 60` in bash; never park or release.",
		parameters: z.object({
			pr: z.string().describe("The PR number on this workload's repository, e.g. 17."),
			slice: z.string().optional().describe("An open slice (sl-…) on this workload for the run to settle; omit it and the runner adds the full-suite slice."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "requested");
			if (!o.ok) return o.result;
			const prText = String(params.pr ?? "").trim().replace(/^#/, "");
			if (!/^[1-9]\d*$/.test(prText) || !Number.isSafeInteger(Number(prText))) return text(`A full test run names its PR by number (e.g. 17); \`${prText}\` is not one. Nothing was requested.`);
			const slice = typeof params.slice === "string" && params.slice.trim() ? params.slice.trim() : null;
			if (slice !== null) {
				if (!SLICE_ID_RE.test(slice)) return text(`\`${slice}\` is not a slice id the test runner records (sl-…, no spaces); nothing was requested.`);
				const row = o.own.ledger.slice(slice);
				if (!row || row.workload_id !== o.own.workloadId) return text(`Slice ${slice} is not on workload ${o.own.workloadId}; nothing was requested.`);
				if (row.state !== "open") {
					const why = row.state === "paused" ? " (a question on it waits on Jo; the runner cannot settle a paused slice until it is answered or withdrawn)" : "";
					return text(`Slice ${slice} is ${row.state}, not open${why}; nothing was requested.`);
				}
			}
			if (!pi.exec) return text("The host has no exec for extensions, so the test runner's starter could not run; nothing was requested.");
			// The lane names a PR and a slice; the workload and the requester are this lane's own, and nothing else reaches the starter.
			const args = [TEST_RUNNER_SCRIPT, "start", o.own.workloadId, prText, ...(slice ? ["--slice", slice] : []), "--requested-by", o.own.laneId];
			try {
				const r = await pi.exec("bun", args, { timeout: STARTER_TIMEOUT_MS });
				const lastOf = (s: string) => s.trim().split("\n").filter(Boolean).at(-1) ?? null;
				if (r.code === 0 && !r.killed) {
					const line = lastOf(r.stdout) ?? "the starter exited 0 without a line";
					return text(`${line}\nThe result arrives as an aside; until then work on something else or \`sleep 60\` in bash.`, { code: 0, line });
				}
				const line = lastOf(r.stderr) ?? lastOf(r.stdout) ?? (r.killed ? "the starter was killed before it printed" : `the starter exited ${r.code} without a line`);
				const how = r.killed ? `the starter did not return within ${STARTER_TIMEOUT_MS / 1000} s and was killed` : `starter exit ${r.code}`;
				return text(`No test run started (${how}): ${line}`, { code: r.code, line });
			} catch (err) {
				return text(`No test run started: the starter could not be run: ${String(err)}`, { code: null });
			}
		},
	});

	pi.registerTool({
		name: LANE_TRAIN_RETURN_TOOL,
		loadMode: "essential",
		label: "Return PR to Owner",
		description:
			"Merge-train lanes only: hand a PR the train cannot land back to its owner as a task (no question to Jo). `kind` is red (the suite), conflict (the resolver could not fix it) or stack (a dependency problem); " +
			"`detail` is the absolute path of a file holding the first failures and errors (run id, head, failing tests, the resolver's message, the chain), which becomes the task's body. " +
			"The tool reads the PR's current head and owner, sets the attempt and records the task; the train tick delivers and settles it. Then go on to the next PR.",
		parameters: z.object({
			pr: z.string().describe("The PR number on this train, e.g. 17."),
			kind: z.enum(TRAIN_TASK_KINDS).describe("red | conflict | stack."),
			detail: z.string().describe("The absolute path of the detail file (under $AS2_SCRATCH)."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "returned");
			if (!o.ok) return o.result;
			const { ledger, workloadId, laneId } = o.own;
			const prText = String(params.pr ?? "").trim().replace(/^#/, "");
			if (!/^[1-9]\d*$/.test(prText) || !Number.isSafeInteger(Number(prText))) return text(`A returned PR is named by number (e.g. 17); \`${prText}\` is not one. Nothing was returned.`);
			const pr = Number(prText);
			const kind = String(params.kind ?? "") as TrainTaskKind;
			const path = String(params.detail ?? "").trim();
			if (!isAbsolute(path)) return text(`detail is the absolute path of the detail file; \`${path}\` is not absolute. Nothing was returned.`);
			let detail: string;
			try {
				if (statSync(path).size > TRAIN_DETAIL_MAX_BYTES) return text(`${path} is over ${TRAIN_DETAIL_MAX_BYTES} bytes; keep the first failures and errors. Nothing was returned.`);
				detail = readFileSync(path, "utf8");
			} catch (err) {
				return text(`The detail file ${path} could not be read (${String(err)}); nothing was returned.`);
			}
			const checkout = repoOf(ledger, workloadId);
			const trainRepo = checkout === null ? null : checkoutOwnerRepo(checkout);
			if (trainRepo === null) return text(`Workload ${workloadId} has no repo: checkout with a GitHub origin, so the PR's owner cannot be read; nothing was returned.`);
			if (!pi.exec) return text("The host has no exec for extensions, so gh could not read the PR; nothing was returned.");
			let view: TaskView | null;
			try {
				const r = await pi.exec("gh", ["pr", "view", prText, "-R", trainRepo, "--json", TASK_VIEW_FIELDS], { timeout: STARTER_TIMEOUT_MS });
				if (r.code !== 0 || r.killed) return text(`gh pr view ${pr} -R ${trainRepo} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}. Nothing was returned.`);
				view = taskViewOf(JSON.parse(r.stdout));
			} catch (err) {
				return text(`gh pr view ${pr} -R ${trainRepo} could not be read: ${String(err)}. Nothing was returned.`);
			}
			if (view === null) return text(`gh pr view ${pr} -R ${trainRepo} returned an unexpected shape; nothing was returned.`);
			const r = recordTrainTask(ledger, { train: workloadId, by: laneId, pr, kind, detail, view, trainRepo });
			if (!r.ok) return text(`${r.reason}. Nothing was returned.`);
			const t = r.task;
			const who = t.owner ?? "none yet (the tick delivers to the PR's open fix workload, or opens one)";
			return text(`Recorded task ${t.id} (${t.entryId}): #${pr} attempt ${t.attempt}, kind ${t.kind}, head ${t.head}, owner ${who}. The train tick delivers and settles it; go on to the next PR.`, { id: t.id });
		},
	});

	pi.registerTool({
		name: LANE_READ_FACTS_TOOL,
		loadMode: "essential",
		label: "Read Repo Facts",
		description:
			"The unbudgeted read of the M8 repo facts the first prompt's Repo facts block draws from: every fact for this workload's repo (its `repo:` entry), or for the `repo` you name. " +
			"Use it for the rest of the facts when the block says more exist, or for another repo. `match` narrows to facts whose text or source contains it (case-insensitive).",
		parameters: z.object({
			repo: z.string().optional().describe("The repo's absolute path, as the facts key it; omit it for this workload's repo."),
			match: z.string().optional().describe("A case-insensitive substring of a fact's text or source path; omit it for every fact."),
		}),
		approval: "read",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "read");
			if (!o.ok) return o.result;
			const { ledger, workloadId } = o.own;
			const named = typeof params.repo === "string" ? params.repo.trim() : "";
			const match = typeof params.match === "string" ? params.match : "";
			let repo = named;
			try {
				repo ||= repoOf(ledger, workloadId) ?? "";
				if (!repo) return text(`Workload ${workloadId} has no \`repo:\` entry; name \`repo\` to read its facts. Nothing was read.`);
				return text(readFacts(ledger.facts(repo), repo, match || undefined));
			} catch (err) {
				return text(`could not read facts for ${repo || `workload ${workloadId}'s repo`} (${err instanceof Error ? err.message : String(err)})`);
			}
		},
	});

	pi.registerTool({
		name: LANE_RELEASE_TOOL,
		loadMode: "essential",
		label: "Release Workload",
		description:
			"Release this lane's workload and end the lane: the work is done (record `done-because:` first) or this lane can do no more. " +
			"Terminal: after it every lane tool refuses and the session ends.",
		parameters: z.object({}),
		approval: "write",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "released");
			if (!o.ok) return o.result;
			const refused = handsUnsettled(o.own, "released");
			if (refused) return refused;
			const { ledger, workloadId, laneId } = o.own;
			let r: { released: boolean; holder?: string | null };
			try {
				// D4: the marker and the release commit together, release first; a refused release writes no marker, and a
				// failed marker insert rolls the release back, so there is never an unmarked release of open work.
				r = ledger.write(() => {
					deploysUnsettled(o.own);
					const released = ledger.releaseWorkload(workloadId, { by: laneId, holder: laneId });
					if (!released.released) return released;
					const entries = ledger.entries(workloadId);
					const slices = sliceCounts(ledger.slices(workloadId));
					const open = slices.open + slices.paused;
					if (open > 0 && doneBecause(entries, holdersOf(entries, laneId, ledger.holders(workloadId))) === null) {
						ledger.recordEntry({ by: laneId, workloadId, kind: "assumption", body: releasedOpenBody(laneId, open) });
					}
					return released;
				});
			} catch (err) {
				return text(`Workload ${workloadId} could not be released: ${err instanceof Error ? err.message : String(err)}; this lane still holds it and nothing was released.`);
			}
			if (!r.released) return text(`Workload ${workloadId} is held by ${r.holder ?? "nobody"}, not by this lane; nothing was released.`);
			return text(`Released ${workloadId}. ${endSession(ctx)}`, { released: true });
		},
	});

	pi.registerTool({
		name: LANE_HANDOFF_TOOL,
		loadMode: "essential",
		label: "Hand Off to Jo",
		description:
			"Hand this lane's workload to Jo (\"I've got X\"): Jo becomes the holder with no lease, and this lane ends. " +
			"Terminal: after it every lane tool refuses and the session ends.",
		parameters: z.object({}),
		approval: "write",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const o = owned(ctx, "handed off");
			if (!o.ok) return o.result;
			const refused = handsUnsettled(o.own, "handed off");
			if (refused) return refused;
			let r: HandoffResult;
			try {
				r = o.own.ledger.write(() => {
					deploysUnsettled(o.own);
					return o.own.ledger.handoffWorkload(o.own.workloadId, { by: o.own.laneId, holder: o.own.laneId, to: JO_HOLDER });
				});
			} catch (err) {
				return text(`Workload ${o.own.workloadId} could not be handed off: ${err instanceof Error ? err.message : String(err)}; nothing was handed off.`);
			}
			if (!r.ok) return text(`Workload ${o.own.workloadId} is held by ${r.holder ?? "nobody"}, not by this lane; nothing was handed off.`);
			return text(`Handed ${o.own.workloadId} to Jo (holder ${JO_HOLDER}, no lease). ${endSession(ctx)}`, { handedOff: true });
		},
	});
}
