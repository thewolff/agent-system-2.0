#!/usr/bin/env bun
// train-tick: the merge train's level-triggered tick (PLAN wl-mv8s8srodefytc rev 17.1 D9-D10), run every 5 minutes by launchd
// (install/com.agent-system-2.train-tick.plist, written by install.sh --train-tick), outside the fence.
//
//   bun surface/scripts/train-tick.ts
//
// Every run recomputes from the ledger ($AGENT_SYSTEM_LEDGER_DB, else ~/.agent-system-2/ledger.db) and GitHub, so no one-shot
// event is lost. The logic is in surface/src/merge-train.ts; this script does the effects, in order:
//  1. Facts. Per open train, `gh pr view <n> -R <repo> --json <TASK_VIEW_FIELDS>,state,body,mergedAt` for each PR whose disposition
//     slice is not done or cancelled, and `gh pr view <d> --json state,mergedAt` for each `Depends-on: #d` not already read. For
//     each PR with an unsettled task, the pushes to its head branch from GitHub's repository activity (`trainActivityArgs`, every
//     page): D8's push evidence, at GitHub's time of the push.
//  2. Settles (D8). `settleTasks` at the PRs' current heads and pushes; each `train-task-settled:` is written once, as MERGE_TRAIN_BY.
//     A PR whose activity could not be read this pass has no push evidence, so neither push rule settles it. Before that write,
//     each (S, head) pair `carryPairs` lists, a green at S the head may keep, is compared on GitHub (`ghCompare`, PLAN
//     wl-mvpwkpqobyp20w D2) outside the ledger's transaction; a pair it cannot compare is absent, so that green does not carry.
//     Then the failed-twice alert question (`raiseTwiceFailed`, options retry / skip / stop) for each PR whose attempt 2 settled failed.
//  3. Deliveries (D7, D10 step 2). A task with no open owner gets its fix workload (`openTrainFix`: at most one per (repo, PR),
//     reused when open), except on a fork's PR (`forkOf`): no workload can push there, so the tick settles the task failed
//     and raises the retry / skip / stop alert instead (`forkTaskAlert`). An autonomous owner that is not held live is launched
//     with `launch-requested: by merge-train` once per task and again only after a runner result newer than its last launch, so
//     an owner waiting on its run is not relaunched.
//  4. Wakes (D10 step 1). A train `actionable` (a new `train:`, a settle, an unworked PR, a dependency merged on GitHub since the
//     last ready lane exit, Jo's answer to an alert or to a question the train's lane raised and no ready lane has carried yet,
//     a passed-over PR whose retry wait has passed, a returned PR's head the train has not worked, from step 1's views, or a
//     held PR whose hold has ended, `hold-expired`, PLAN wl-mvfkv7llkp7nk0 § 3) and not held live gets the launcher: on its own
//     cause when it has one (`first`, a pending request, an unconsumed resolution, PLAN wl-mvpsrr4tr0p1xc D2), so the attempt
//     names and consumes it, else, only when its verdict reads `died-not-relaunched`, after `launch-requested: by merge-train`;
//     any other refusal read at request time (`held` by a lane another path started since the wake read, `awaiting-close`, …)
//     gets no request and no launcher, one log line (review r1 F2). A head's wake is recorded (`train-head-woken:`) when
//     the tick requested a lane for it (wrote the request, or its launcher served a pending one or the train's own cause), once
//     per request, whichever starter serves it; the head stays due under the pass-over backoff until the train works it
//     (`trainRetries`). An ended hold's wake is recorded at the same request boundary (`train-wake: pr <n> hold <entry id>`),
//     which consumes that hold's expiry. At the launch limit (D4: TRAIN_LAUNCH_LIMIT consecutive launches that never got ready,
//     `trainLaunchFailures`) a train gets no request and no launcher, one log line, and Jo's NOW (incident) question once per
//     episode (`raiseLaunchLimit`, relaunch / stop, on the slice of its first non-terminal PR, so step 5 files its issue).
//     An open question never stops the tick: every pass settles, delivers and wakes on every PR.
//     Steps 3 and 4 request nothing for a workload stopped at its ceiling (`ceilingStopped`): no row, no launcher, a log line only.
//  5. Alerts (D9). Each question on a train slice is an alert: the production merge question the lane raises and the failed-twice
//     question of step 2. The send ladder (`trainAlertActions`): level 1 files an issue on TRAIN_ALERT_REPO labelled as2-train;
//     4 h and 8 h after it, while the question is open and the issue is not closed, a comment mentioning @thewolff, the `loud`
//     (then also `critical`) label, a macOS notification with sound, and the LOUD needs-you line (surface/src/errors.ts). Each send
//     writes `train-alert: <q> level <n> sending`, does its effects (the issue body and each comment carry a marker the tick looks
//     for before creating one, and again after a failed create before anything is retried, adopting an issue the failed call filed;
//     only a missing label is retried, once, after the label is created; labels are only added, never removed; the notification
//     only when `notified` is not written), then `sent`. Jo closing the issue is the ack (`acked`): no more re-sends. Jo's answer
//     or withdrawal closes the issue (`closed`), found by its marker when level 1 was begun and its url never recorded. The marker
//     lookup reads every as2-train issue (`ISSUE_LIST_ARGS`, every page); a lookup that fails or reads an unexpected shape throws,
//     so nothing is created and no `closed` is written on a partial answer: the action stays due for the next pass.
// 3b. Boarding (PLAN wl-mvbjiettjrfpxc D1, D3, D4). The first pass writes the cutover, `train-autoboard: on <iso>`, once on the
//     standing workload. Then every recent closed workload or released landing receipt on a served repository (`autoboardCandidates`,
//     newest readiness first; a train, a fix workload, a W a board still covers and a W whose PR ended are not read) gets `landingReady`,
//     and a ready one the live half: `gh pr view <n> --json <TASK_VIEW_FIELDS>,state,baseRefName,isDraft` (OPEN, no draft, base
//     main, head branch exactly wl/<W> on the same repository, `prStakes` normal) and, when the head is not the green sha G,
//     `ghCompare(G, head)` judged by `decisionLogFault`: the head descends from G through single-parent commits each touching only
//     .ai/decision-log/ (never the net diff). The ready PRs board (`boardLanding`) oldest close first; the board makes the train
//     actionable, so step 4 launches it. A W that cannot board gets `train-board-skip:` once per head and reason; a PR GitHub
//     shows MERGED or CLOSED gets an `ended:` one, and its W is never read again.
// 3c. Protection (D6). Per repository with an open train holding a non-terminal PR, a boardable PR or an open episode, main's
//     protection is read live (`protectionGap`): `train-notice: protection <owner/repo> ok|gap|unknown <text>` on each change,
//     `raised` (the needs-you line, surface/src/errors.ts) on a gap or on an unknown that is the newest read and 10 min old, one
//     jo-issues issue (`filed`), and on `ok` the issue closed with a comment, `cleared`, and every train that passed a PR over for
//     protection woken. While an episode is open, protection pass-overs get no backoff wake.
// 3d. Red main (D7). Each holder `main-red: <url> run <id>` on a train open or closed within 24 h whose url is an issue on that
//     train's repository: `train-notice: main-red <url> raised run <id>` once per url, one jo-issues issue (`filed`), and
//     `cleared` (the jo-issues issue closed) once `gh issue view` shows that issue CLOSED. Any other url is logged only.
// 3e. Merge notices (PLAN wl-mvg8itbt0rz3ls D4). Each train open or closed within 24 h (the window of 3d), each of its slices
//     `sl-train-<k>-<n>` done with an artifact starting `merged by train`: in one write, unless the standing workload has it,
//     `train-notice: merged <owner/repo> #<n> <train>` and one notice to Jo (`trainMergedNoticeBody`, surface/src/notice.ts),
//     naming production sign-off when a holder of the train recorded `ruling-applied: train-signoff …` on that slice, else
//     normal stakes. Jo's own merge (`merged by Jo …`) and a skip get none; a train whose repository cannot be read is logged.
//
// A gh failure is logged on the train as `train-error: tick <reason>` (written again only when the reason changes) and retried
// next run; Jo is not alerted (a boarding or notice failure is logged in the tick's log only). The launcher is
// `bun surface/scripts/lane.ts launch <wl> --requested-by merge-train`. Steps 3b-3e need the standing workload; without it they
// are skipped and logged. Exit: 0 the pass ran (logged errors included), 1 the ledger could not be opened, 2 an argument was given.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { AS2_VERIFIED_TAG } from "../src/as2test";
import { ceilingStopped } from "../src/ceiling";
import { checkoutConfigPath, loadTestRunnerConfig } from "../src/close-entry";
import {
	attempts, consumedIds, controlEntries, heldLive, holdersOf, LANE_SCRIPT, laneCap, landFirstOffBody, landFirstOffPending, landFirstOn, launchRequestedBody, launchRowsFor, mainRetries, sameRepo, trainBindings, verdictOf,
} from "../src/launch";
import { attemptBlock, type ChainCommit, ghMainChain, INCONCLUSIVE, type MainState, mainResults, mainState, mainVerdicts } from "../src/main-state";
import {
	actionable, type AlertAction, autoboardCandidates, autoboardCutover, BOARD_ENDED, boardedWorkloads, boardLanding, boardSkips, carryPairs, checkoutOwnerRepo, type ControlRoot,
	controlRootRefusal, everyTrain, expiredHolds, forkOf, forkTaskAlert, FULL_SUITE_STATUS, ghCompare, isTrainOrFix, type LandFirstEvent, landFirstNoticeBody, landFirstRepos, landFirstRows,
	type Landing, landingPassOvers, landingReady, lastReadyExit, MAIN_RED_WINDOW_MS, MAIN_RETRY_MS, mainRedNoticeBody, mainRedNotices, mainRedRows, openTrainFix, openTrains, ownerDeliveries,
	PROMOTE_ATTEMPTS, PROTECTION_UNKNOWN_RAISE_MS, protectionEpisodes, protectionGap, protectionNoticeBody, type ProtectionNoticeState, protectionPassOvers, prStakes, raiseLaunchLimit,
	raiseTwiceFailed, REPAIR_FAIL_MS, REVOKE_ATTEMPTS, settleTasks, stopEpisode, stopSummary, TASK_VIEW_FIELDS, type TaskView, taskViewOf, TRAIN_ALERT_LABEL, TRAIN_ALERT_LADDER,
	TRAIN_ALERT_MENTION, TRAIN_ALERT_REPO, trainActivityArgs, trainAlertActions, trainAlertBody, trainAlertEndBody, trainAlertMarker, trainAutoboardBody, trainBoardSkipBody, trainCheckout,
	trainHeadWokenBody, TRAIN_LAUNCH_LIMIT, trainLaunchFailures, trainPrs, trainPushesOf, trainReconciledBody, trainRetries, trainSliceId, trainSlicePr, type TrainPush, type TrainTask,
	trainFixModelOf, trainWakeBody, twiceFailed, unsettledTasks,
} from "../src/merge-train";
import { bodyDeps, DEFAULT_BRANCH } from "../src/merge-train-stack";
import { sendNotice, TRAIN_SIGNOFF_APPLIED_PREFIX, trainMergedEntryBody, trainMergedNoticeBody } from "../src/notice";
import { type CompareResult, decisionLogFault, fastPlans, ownerRepoOf, type ResultRecord, runsRoot, type TestRunnerConfig, testRuns, withFullSuitePublication } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID } from "../src/types";

/** One gh process: its exit code and output. */
export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The tick's land-first seams (PLAN wl-mvq4edbaf13vnk D6, § 2 Protect the verifier): the runner's entry points and the tick's own root. */
export interface LandDeps {
	/**
	 * `bun surface/scripts/test-runner.ts <args>`, run outside the fence; its exit code and output. The tick calls `reap` (settle
	 * every admitted main request with no settle and no live heartbeat `runner died`; a no-op when there is none), `main --repo
	 * <owner/repo> --sha <T>` (request a main run at T: the runner admits it as the active run or replaces the pending target,
	 * and answers 0 doing nothing when T is already either), and `promote --sha <G>` (move `verified/current`, then the tag, to
	 * G; exit 0 with last line `promoted <G>`, or `schema <sha>` when it stopped before that schema-changing commit).
	 */
	runner: (args: string[]) => GhResult;
	/** The tick's own control root, read now (`ControlRoot`); throws when git or the file system cannot answer. */
	root: () => ControlRoot;
	/** Configured runner runs root; tests inject an isolated directory. No new operator configuration. */
	runsRoot?: string;
}

/** The tick's seams: gh, the lane launcher and the notification are injected, so a test runs a pass on fakes and a temp ledger. */
export interface TickDeps {
	ledger: Ledger;
	gh: (args: string[], timeoutMs?: number) => GhResult;
	/** `lane.ts launch <wl> --requested-by merge-train`: its exit code and last line. */
	launch: (wl: string) => { code: number; line: string };
	/** A macOS notification with sound; false when it could not be shown. */
	notify: (title: string, text: string) => boolean;
	/** The test runner's served repositories (`testRunner.repos`, profile/config.yml): only their PRs board (D1); none, nothing boards. */
	config?: Pick<TestRunnerConfig, "repos">;
	/** Land-first's seams; without them the main-run pass (step 3f) is skipped with one log line. `main()` always passes them. */
	land?: LandDeps;
	/** The profile's `trainFixModel:` (`trainFixModelOf`): the lane-model preference a newly opened fix workload carries; absent or null, none. */
	trainFixModel?: string | null;
	log?: (line: string) => void;
}

/** What the tick reads of a train PR: D1's fields and the head, plus its state, body (Depends-on lines) and merge time. */
type PrView = TaskView & { state: string; body: string; mergedAt: string | null };

const PR_FIELDS = `${TASK_VIEW_FIELDS},state,body,mergedAt`;
/**
 * Every issue the train filed, any state, read whole to find a marker: the REST issue listing (`GET /repos/{o}/{r}/issues`, the
 * as2-train label) through its last page (`--paginate --slurp`, an array of pages), not the search index, so an issue created a
 * moment ago is in it and none is beyond a bound.
 */
const ISSUE_LIST_ARGS = [
	"api", `repos/${TRAIN_ALERT_REPO}/issues`, "--method", "GET", "--paginate", "--slurp", "-f", `labels=${TRAIN_ALERT_LABEL}`, "-f", "state=all", "-f", "per_page=100",
];

class GhError extends Error {}

interface TrainFacts {
	wl: string;
	repo: string;
	checkout: string;
	views: Map<number, PrView>;
	pushes: Map<number, TrainPush[]>;
	mergedDeps: number[];
}

/** `json[key]` when `json` is an object, else undefined: gh's JSON is read one field at a time, each checked where it is used. */
function field(json: unknown, key: string): unknown {
	return typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;
}

/** One pass of the tick (D10); returns the lines it logged. */
export function tick(d: TickDeps): string[] {
	const out: string[] = [];
	const say = (line: string) => {
		out.push(line);
		d.log?.(line);
	};
	const { ledger } = d;
	const ghJson = (args: string[]): unknown => {
		const r = d.gh(args);
		if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? ""}`);
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new GhError(`gh ${args.slice(0, 3).join(" ")} did not return json`);
		}
	};
	/** `train-error: tick <reason>` on the train, unless its newest tick error says the same. */
	const trainError = (wl: string, err: unknown) => {
		const body = `train-error: tick ${String(err instanceof Error ? err.message : err).replace(/\s+/g, " ").trim()}`;
		const last = ledger.entries(wl, "assumption").filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith("train-error:")).at(-1);
		if (last?.body !== body) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body });
		say(`${wl}: ${body}`);
	};
	// § 2 Protect the verifier (R18): while land-first is on for any repository, a tick whose own root fails the self-check
	// refuses to run: one `tick-refused` row per reason (again after a pass reconciled since), then nothing else this pass.
	let root: ControlRoot | null = null;
	if (d.land && ledger.workload(STANDING_WORKLOAD_ID)) {
		const entries = ledger.entries(STANDING_WORKLOAD_ID);
		const on = landFirstRepos(entries, ledger.instructions(STANDING_WORKLOAD_ID), true);
		let refusal: string[];
		try {
			root = d.land.root();
			refusal = controlRootRefusal(root, entries);
		} catch (err) {
			refusal = [`the tick's control root could not be read: ${err instanceof Error ? err.message : String(err)}`];
		}
		if (refusal.length > 0 && on.length > 0) {
			const reason = refusal.join("; ").replace(/\s+/g, " ").trim();
			const prior = landFirstRows(entries, "*").findLast((r) => r.event === "tick-refused");
			const since = prior === undefined ? false : controlEntries(entries).some((c) => c.prefix === "train-reconciled" && c.createdAt > prior.createdAt);
			if (prior?.event !== "tick-refused" || prior.reason !== reason || since) {
				ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstNoticeBody("*", { event: "tick-refused", reason }) });
			}
			say(`train tick refused: land-first is on for ${on.join(", ")} and the tick's root fails the self-check: ${reason} — reinstall from verified/current (install/install.sh --control-root=verified)`);
			return out;
		}
	}
	/**
	 * Run the launcher for `wl`, after writing `launch-requested: by merge-train` unless one is unconsumed already. On an open
	 * train (cap-exempt, PLAN wl-mvpsrr4tr0p1xc D2) the verdict (`launchRowsFor` + `verdictOf`) is read first: when the train's
	 * own cause admits it (`first`, an unconsumed resolution) the launcher runs with no request, so the attempt names and
	 * consumes that cause; only `died-not-relaunched` gets the request; any other refusal (`held` by a lane another path
	 * launched since step 4 read the train, `awaiting-close`, `user-driven`, …) writes nothing and runs no launcher, so no
	 * request outlives that lane to wake an idle train (review r1 F2). The pending-request lookup, the verdict read and the
	 * request's insert are one write transaction (BEGIN IMMEDIATE), so no other starter's reservation lands between the read
	 * and the insert (review r2 F5); the launcher runs after it commits, as it takes its own reservation transaction. Returns
	 * the launcher's exit code, whether this call wrote the request, the id of the request now pending (null when the train's
	 * own cause was launched) and the workload's entry count before the launch. Null, with nothing written and no launcher,
	 * when the workload is stopped at its ceiling (`ceilingStopped`, PLAN wl-mvgn310dpi5gcg D3) or the train's verdict refuses
	 * with another reason; one line says which.
	 */
	const request = (wl: string, reason: string): { code: number; wrote: boolean; requestId: string | null; before: number } | null => {
		const entries = ledger.entries(wl);
		const w = ledger.workload(wl);
		const control = controlEntries(entries, holdersOf(entries, w?.holder ?? null, ledger.holders(wl)));
		const stopped = w ? ceilingStopped(control, ledger.instructions(wl), w.stakes) : null;
		if (stopped) {
			say(`${wl}: launch (${reason}) not requested: stopped at its ceiling usd ${stopped.spend.usd} of ${stopped.ceiling.usd}`);
			return null;
		}
		const decided = ledger.write((): { wrote: boolean; requestId: string | null } | { refused: string } => {
			// re-read inside the transaction: the rows read above may predate another starter's reservation
			const fresh = ledger.entries(wl);
			const freshControl = controlEntries(fresh, holdersOf(fresh, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)));
			const consumed = consumedIds(attempts(freshControl));
			const pending = freshControl.find((c) => c.prefix === "launch-requested" && !consumed.has(c.id));
			if (pending !== undefined) return { wrote: false, requestId: pending.id };
			const rows = launchRowsFor(ledger, wl, laneCap(process.env));
			const verdict = rows !== null && rows.capExempt ? verdictOf(rows) : null;
			if (verdict !== null && !verdict.launch && verdict.reason !== "died-not-relaunched") return { refused: verdict.reason };
			if (verdict !== null && verdict.launch) return { wrote: false, requestId: null };
			return { wrote: true, requestId: ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, ledger.now(), reason) }) };
		});
		if ("refused" in decided) {
			say(`${wl}: launch (${reason}) not requested: ${decided.refused}`);
			return null;
		}
		const before = ledger.entries(wl).length;
		const r = d.launch(wl);
		say(`${wl}: launch (${reason}): exit ${r.code}: ${r.line}`);
		return { code: r.code, before, ...decided };
	};

	// 1-2. Facts and settles, per train.
	const trains: TrainFacts[] = [];
	for (const wl of openTrains(ledger)) {
		try {
			const checkout = trainCheckout(ledger, wl);
			const repo = checkout === null ? null : checkoutOwnerRepo(checkout);
			if (checkout === null || repo === null) throw new Error(`no GitHub repository for the train's repo: checkout ${checkout ?? "(none)"}`);
			const facts: TrainFacts = { wl, repo, checkout, views: new Map(), pushes: new Map(), mergedDeps: [] };
			trains.push(facts);
			const errors: unknown[] = [];
			for (const n of trainPrs(ledger.entries(wl), ledger.instructions(wl))) {
				const sl = ledger.slice(trainSliceId(wl, n));
				if (sl && (sl.state === "done" || sl.state === "cancelled")) continue;
				try {
					const v = ghJson(["pr", "view", String(n), "-R", repo, "--json", PR_FIELDS]);
					const view = taskViewOf(v);
					const state = field(v, "state");
					if (!view || view.number !== n || typeof state !== "string") throw new GhError(`gh pr view ${n} returned an unexpected shape`);
					const body = field(v, "body");
					const mergedAt = field(v, "mergedAt");
					facts.views.set(n, { ...view, state, body: typeof body === "string" ? body : "", mergedAt: typeof mergedAt === "string" ? mergedAt : null });
				} catch (err) {
					errors.push(err);
				}
			}
			// D8's push evidence: GitHub's pushes to the head branch of each PR with an unsettled task. A fork's branch is not on
			// `repo`, and a listing that fails or reads wrong is no evidence: such a PR is absent from `pushes` this pass.
			for (const n of new Set(unsettledTasks(ledger, wl).map((t) => t.pr))) {
				const v = facts.views.get(n);
				if (!v || forkOf(v, repo) !== null) continue;
				try {
					const pushes = trainPushesOf(ghJson(trainActivityArgs(repo, v.headRefName)), v.headRefName);
					if (pushes === null) throw new GhError(`gh api repos/${repo}/activity for #${n} returned an unexpected shape`);
					facts.pushes.set(n, pushes);
				} catch (err) {
					errors.push(err);
				}
			}
			const heads = new Map([...facts.views].map(([n, v]) => [n, v.headRefOid]));
			// D2's compares, read before the settle transaction: no gh call holds the ledger's lock.
			const compares = new Map<string, CompareResult | null>();
			for (const p of carryPairs(ledger, { train: wl, heads })) {
				try {
					const c = ghCompare(repo, p.from, p.to, ghJson);
					if (c.ok) compares.set(`${p.from} ${p.to}`, c.compare);
				} catch (err) {
					errors.push(err);
				}
			}
			const settled = ledger.write(() => {
				const bodies = settleTasks(ledger, { train: wl, heads, pushes: facts.pushes, compares }, ledger.now());
				for (const body of bodies) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body });
				return bodies;
			});
			for (const body of settled) say(`${wl}: ${body}`);
			for (const due of twiceFailed(ledger, wl)) {
				const q = raiseTwiceFailed(ledger, wl, due);
				if (q) say(`${wl}: #${due.pr} failed twice (${due.task.id}): alert question ${q}`);
			}
			// A dependency merged since the train's last ready lane exit wakes it (actionable's mergedDeps; a never-ready exit cuts nothing, D2).
			const lastExit = lastReadyExit(controlEntries(ledger.entries(wl)));
			const merged = new Map<number, string | null>();
			for (const [n, v] of facts.views) {
				for (const dep of bodyDeps(v.body)) {
					if (!merged.has(dep)) {
						const known = facts.views.get(dep);
						try {
							const dv = known ?? ghJson(["pr", "view", String(dep), "-R", repo, "--json", "state,mergedAt"]);
							const at = field(dv, "mergedAt");
							merged.set(dep, field(dv, "state") === "MERGED" && typeof at === "string" ? at : null);
						} catch (err) {
							errors.push(err);
							merged.set(dep, null);
						}
					}
					const at = merged.get(dep);
					if (at && (lastExit === null || Date.parse(at) > Date.parse(lastExit)) && !facts.mergedDeps.includes(n)) facts.mergedDeps.push(n);
				}
			}
			if (errors.length > 0) trainError(wl, errors[0]);
		} catch (err) {
			trainError(wl, err);
		}
	}
	const factsOf = (wl: string) => trains.find((t) => t.wl === wl);

	// 3. Deliveries: the fix workload for a task with no open owner, then each owner not held live.
	for (const del of ownerDeliveries(ledger)) {
		if (del.kind !== "fix") continue;
		const t = del.task;
		const facts = factsOf(t.train);
		const view = facts?.views.get(t.pr);
		if (!facts || !view) continue;
		try {
			if (forkOf(view, facts.repo) !== null) {
				const q = forkTaskAlert(ledger, t, view, facts.repo);
				say(`${t.train}: #${t.pr} task ${t.id}: head on a fork, settled failed${q ? `, alert question ${q}` : ""}`);
				continue;
			}
			const s = prStakes(view, facts.repo, ledger);
			const r = openTrainFix(ledger, {
				task: t, repo: facts.repo, checkout: facts.checkout, view, stakes: s.stakes === "production" ? "production" : "normal", preferredModel: d.trainFixModel ?? null,
			});
			say(`${t.train}: #${t.pr} task ${t.id}: fix workload ${r.workloadId} ${r.opened ? "opened" : "reused"}`);
		} catch (err) {
			trainError(t.train, err);
		}
	}
	const launched = new Set<string>();
	for (const del of ownerDeliveries(ledger)) {
		if (del.kind !== "launch" || launched.has(del.owner) || !ownerLaunchDue(ledger, del.owner, del.task)) continue;
		launched.add(del.owner);
		request(del.owner, `train task ${del.task.id} on #${del.task.pr}`);
	}

	// 3b-3e. Boarding, main's protection, red main, merge notices: rows on the standing workload, so none runs without it.
	/** A train's repository as lowercase `owner/repo` (step 1's, else its checkout's origin); null when it has none. */
	const repos = new Map<string, string | null>();
	const repoOf = (wl: string): string | null => {
		if (!repos.has(wl)) {
			const checkout = factsOf(wl)?.checkout ?? trainCheckout(ledger, wl);
			const repo = factsOf(wl)?.repo ?? (checkout === null ? null : checkoutOwnerRepo(checkout));
			repos.set(wl, repo?.toLowerCase() ?? null);
		}
		return repos.get(wl)!;
	};
	let notices: { wake: Map<string, string>; open: Set<string> } = { wake: new Map(), open: new Set() };
	let land: LandResult | null = null;
	if (!ledger.workload(STANDING_WORKLOAD_ID)) say(`${STANDING_WORKLOAD_ID}: no standing workload: boarding, protection, red-main, merge notices and main runs skipped`);
	else {
		if (autoboardCutover(ledger) === null) {
			const body = trainAutoboardBody(ledger.now());
			ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
			say(`${STANDING_WORKLOAD_ID}: ${body}`);
		}
		const boardable = boardingPass(d, ghJson, say);
		const ops = issueOps(d, ghJson);
		// D6's read set: a repo with an open train holding a non-terminal PR, a boardable PR, or an open episode (protectionPass).
		const read = new Set(boardable.map((b) => b.l.repo.toLowerCase()));
		for (const wl of openTrains(ledger)) {
			const repo = repoOf(wl);
			const pending = trainPrs(ledger.entries(wl), ledger.instructions(wl)).some((n) => {
				const sl = ledger.slice(trainSliceId(wl, n));
				return !(sl && (sl.state === "done" || sl.state === "cancelled"));
			});
			if (repo !== null && pending) read.add(repo);
		}
		notices = protectionPass(d, ghJson, ops, say, read, repoOf);
		mainRedPass(d, ghJson, ops, say);
		mergeNoticePass(d, say, repoOf);
		// 3f. Main runs, landing and promotion (PLAN wl-mvq4edbaf13vnk D6).
		const served = servedRepos(d.config, say);
		if (d.land) land = landPass(d, d.land, ghJson, ops, say, repoOf, served, root);
		else if (served.length > 0) say("land-first: no runner seam (TickDeps.land): main runs, landing and promotion skipped this pass");
	}

	// 4. Wakes.
	for (const wl of openTrains(ledger)) {
		const w = ledger.workload(wl);
		if (!w || heldLive(w, ledger.now())) continue;
		const facts = factsOf(wl);
		const heads = new Map([...(facts?.views ?? [])].map(([n, v]) => [n, v.headRefOid]));
		// An `until jo` hold ends when the PR's stakes, read now, no longer hold it until Jo (`expiredHolds`); no view, no answer.
		const stakesOf = (n: number) => {
			const v = facts?.views.get(n);
			return facts && v ? prStakes(v, facts.repo, ledger) : null;
		};
		const untested = trainRetries(ledger, wl, heads).untested;
		const expired = expiredHolds(ledger, wl, stakesOf);
		// D6: while the repo's protection episode is open, a PR passed over for protection waits; its clearing wakes the train.
		// PLAN wl-mvq4edbaf13vnk D6: likewise a PR passed over while the repo's landing is stopped; landing reopening wakes the train.
		const repo = repoOf(wl) ?? "";
		const held = new Set([...(notices.open.has(repo) ? protectionPassOvers(ledger, wl) : []), ...(land?.stopped.has(repo) ? landingPassOvers(ledger, wl) : [])]);
		// D13: a per-PR reason waits while the PR's owner is busy (a live lease, or only an unsettled run); one line per PR.
		const deferred = new Set<number>();
		const headRefs = new Map([...(facts?.views ?? [])].map(([n, v]) => [n, v.headRefName]));
		const why = actionable(ledger, wl, facts?.mergedDeps ?? [], heads, held, stakesOf, {
			headRefs,
			defer: (x) => {
				deferred.add(x.pr);
				say(`${wl}: #${x.pr} wake deferred while its owner is busy: ${x.busy} (${x.reasons.join("; ")})`);
			},
		});
		const cleared = notices.wake.get(wl);
		if (cleared !== undefined) why.push(cleared);
		const reopened = land?.wake.get(wl);
		if (reopened !== undefined) why.push(reopened);
		const repair = land?.repairs.get(wl);
		if (repair !== undefined) why.push(`repair ${repair.tip.slice(0, 7)}`);
		// D4: at the limit nothing is requested and nothing launched; Jo hears it once per episode, NOW.
		const failures = trainLaunchFailures({
			entries: ledger.entries(wl), instructions: ledger.instructions(wl), questions: ledger.questions(wl), holder: w.holder, holderLeaseUntil: w.holder_lease_until, now: ledger.now(),
		});
		if (failures.count >= TRAIN_LAUNCH_LIMIT) {
			if (why.length > 0) say(`${wl}: launch (${why.join("; ")}) not requested: train launch limit: ${failures.count} consecutive failed launches (${failures.lanes.join(", ")})`);
			const q = raiseLaunchLimit(ledger, wl);
			if (typeof q === "string") say(`${wl}: launch limit question ${q} (NOW incident)`);
			else if (q !== null) say(`${wl}: launch limit reached and no PR on the train is open to carry the question`);
			continue;
		}
		// A head the train has not worked: one wake per request the tick made for it, whichever starter serves the request, so a
		// request refused here and served by another starter still counts. A request still pending when the head is due again is
		// the same wake, not a second (PLAN wl-mvgn310dpi5gcg D1); the head stays retried under the backoff (`trainRetries`).
		// An expired hold is consumed by a new or pending request, even if the capped launcher leaves it for the drain to serve.
		// A launch on the train's own cause (no request) counts only when the launcher started it. A ceiling refusal, and a
		// verdict refusal other than `died-not-relaunched` read in `request()`, write no request and consume neither a head wake
		// nor a hold's expiry.
		const r = why.length > 0 ? request(wl, why.join("; ")) : null;
		if (r && (r.wrote || r.code === 0)) {
			const after = ledger.entries(wl);
			const from = r.requestId === null ? r.before : after.findIndex((e) => e.id === r.requestId);
			for (const h of untested) {
				if (deferred.has(h.pr)) continue;
				const body = trainHeadWokenBody(h.pr, h.sha);
				if (after.some((e, i) => i >= from && e.created_by === MERGE_TRAIN_BY && e.kind === "assumption" && e.body === body)) continue;
				ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body });
			}
		}
		if (r && (r.requestId !== null || r.code === 0)) {
			for (const h of expired) if (!deferred.has(h.pr)) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainWakeBody(h.pr, h.holdId) });
			if (repair !== undefined) landNote(d, say, repair.repo, { event: "repair-woken", tip: repair.tip, train: wl });
		}
	}

	// 3f's train-reconciled entries, after the wakes they owed (D6, R18).
	if (land !== null) reconcile(d, land, say);

	// 5. Alerts.
	for (const facts of trains) {
		for (const a of trainAlertActions(ledger, facts.wl, ledger.now())) {
			try {
				alert(d, facts, a, ghJson, say);
			} catch (err) {
				trainError(facts.wl, err);
			}
		}
	}
	return out;
}

/**
 * Whether owner `owner` is launched for task `t` now: an unconsumed `launch-requested:` is waiting (the fix workload's own,
 * or one a failed launch left); or no lane was launched on it since the task; or a runner result on the PR came after its
 * last launch (the run the lane waited for has answered).
 */
function ownerLaunchDue(ledger: Ledger, owner: string, t: TrainTask): boolean {
	const entries = ledger.entries(owner);
	const control = controlEntries(entries, holdersOf(entries, ledger.workload(owner)?.holder ?? null, ledger.holders(owner)));
	const tried = attempts(control);
	const consumed = consumedIds(tried);
	if (control.some((c) => c.prefix === "launch-requested" && !consumed.has(c.id))) return true;
	const last = tried.at(-1)?.createdAt;
	if (last === undefined || last < t.createdAt) return true;
	return testRuns(entries).some((r) => r.request.pr === t.pr && r.result !== null && r.result.createdAt > last);
}

/** The issue number of a jo-issues url. */
function issueNumber(url: string): string {
	const m = /\/issues\/(\d+)$/.exec(url);
	if (!m) throw new GhError(`${url} is not an issue url`);
	return m[1]!;
}

/** A candidate that passed both halves of D1 this pass: its landing and the live head it boards at. */
interface Boardable {
	l: Extract<Landing, { ready: true }>;
	head: string;
}

/**
 * Step 3b (D1, D3, D4): scan the candidates, newest readiness first, through `landingReady` and the live half (`liveHalf`), then board
 * the ready ones oldest readiness first (`boardLanding`). A candidate that cannot board gets `train-board-skip:` once per (W, pr, head,
 * reason); a gh failure is logged only (retried next pass). Returns the PRs that passed both halves, boarded or not.
 */
function boardingPass(d: TickDeps, ghJson: (args: string[]) => unknown, say: (line: string) => void): Boardable[] {
	const { ledger } = d;
	const served = d.config?.repos ?? [];
	const { bodies, ended } = boardSkips(ledger);
	const skip = (wl: string, pr: number | null, head: string | null, reason: string) => {
		const body = trainBoardSkipBody(wl, pr, head, reason);
		if (bodies.has(body)) return;
		bodies.add(body);
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		say(`${STANDING_WORKLOAD_ID}: ${body}`);
	};
	// No served repository (the config unread): nothing to scan, and no skip row that would only say so.
	if (served.length === 0) return [];
	const covered = boardedWorkloads(ledger);
	const origins = new Map<string, string | null>();
	const ownerRepo = (checkout: string) => {
		if (!origins.has(checkout)) origins.set(checkout, checkoutOwnerRepo(checkout));
		return origins.get(checkout)!;
	};
	const ready: Boardable[] = [];
	for (const wl of autoboardCandidates(ledger)) {
		// A train or fix workload is no landing; a W a board covers, or whose PR ended, is not read again (D1).
		if (ended.has(wl) || covered.has(wl) || isTrainOrFix(ledger.entries(wl), ledger.instructions(wl))) continue;
		const l = landingReady(ledger, wl, { config: { repos: served }, ownerRepo });
		if (!l.ready) {
			skip(wl, l.pr, l.sha, l.reason);
			continue;
		}
		try {
			const live = liveHalf(ledger, l, ghJson);
			if (live.ok) ready.push({ l, head: live.head });
			else skip(wl, l.pr, live.head, live.reason);
		} catch (err) {
			say(`${wl}: board #${l.pr}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	ready.sort((a, b) => a.l.readyAt.localeCompare(b.l.readyAt) || a.l.workloadId.localeCompare(b.l.workloadId));
	for (const b of ready) {
		const r = boardLanding(ledger, b.l, { head: b.head });
		if (r.boarded) say(`${r.train}: #${b.l.pr} of ${b.l.workloadId} boarded at ${b.head}${r.opened ? ", train opened" : ""} (${r.entryId})`);
		else skip(b.l.workloadId, b.l.pr, b.head, r.reason);
	}
	return ready;
}

/**
 * D1's live half for ready landing `l`: `gh pr view <n> --json <TASK_VIEW_FIELDS>,state,baseRefName,isDraft` shows it OPEN, no
 * draft, based on main, its head branch exactly `wl/<W>` with `prStakes` normal (same repository, no fork); and its head is the
 * green sha G, or keeps G's green: `decisionLogFault` passes GitHub's compare of G and the head (`ghCompare`, PLAN
 * wl-mvpwkpqobyp20w D3), the one rule, so a merge commit after G never boards and a compare GitHub cannot answer completely
 * never boards either. A failed or unreadable gh call throws.
 */
function liveHalf(ledger: Ledger, l: Extract<Landing, { ready: true }>, ghJson: (args: string[]) => unknown): { ok: true; head: string } | { ok: false; head: string | null; reason: string } {
	const v = ghJson(["pr", "view", String(l.pr), "-R", l.repo, "--json", `${TASK_VIEW_FIELDS},state,baseRefName,isDraft`]);
	const view = taskViewOf(v);
	const [state, base, draft] = [field(v, "state"), field(v, "baseRefName"), field(v, "isDraft")];
	if (!view || view.number !== l.pr || typeof state !== "string" || typeof base !== "string" || typeof draft !== "boolean") {
		throw new GhError(`gh pr view ${l.pr} returned an unexpected shape`);
	}
	const head = view.headRefOid;
	const no = (reason: string) => ({ ok: false as const, head, reason });
	if (state === "MERGED" || state === "CLOSED") return no(`${BOARD_ENDED} #${l.pr} is ${state} on GitHub`);
	if (state !== "OPEN") return no(`#${l.pr} is ${state}`);
	if (draft) return no(`#${l.pr} is a draft`);
	if (base !== DEFAULT_BRANCH) return no(`#${l.pr}'s base is ${base}, not ${DEFAULT_BRANCH}`);
	if (view.headRefName !== `wl/${l.workloadId}`) return no(`#${l.pr}'s head branch ${view.headRefName} is not wl/${l.workloadId}`);
	const stakes = prStakes(view, l.repo, ledger);
	// A PR its workload's plan holds (PLAN wl-mvfkv7llkp7nk0 § 3) does not board; a later pass boards it once the hold has ended.
	if (stakes.stakes === "hold") return no(`#${l.pr} is held: ${stakes.reason} until ${stakes.until}`);
	if (stakes.stakes !== "normal") return no(`#${l.pr} is production: ${stakes.reason}`);
	if (head === l.sha) return { ok: true, head };
	const c = ghCompare(l.repo, l.sha, head, ghJson);
	const fault = c.ok ? decisionLogFault(c.compare) : c.reason;
	return fault === null ? { ok: true, head } : no(`head ${head} is not the green ${l.sha}: ${fault}`);
}

/**
 * Step 3c (D6): main's protection per repository in `read` and per repository with an open episode, read live; the episode's
 * rows, issue and clearing. Returns the trains to wake (a cleared episode's protection pass-overs) and the repositories whose
 * episode is still open (their protection pass-overs get no backoff wake).
 */
function protectionPass(
	d: TickDeps, ghJson: (args: string[]) => unknown, ops: IssueOps, say: (line: string) => void, read: Set<string>, repoOf: (wl: string) => string | null,
): { wake: Map<string, string>; open: Set<string> } {
	const { ledger } = d;
	const write = (repo: string, state: ProtectionNoticeState, text: string) => {
		const body = protectionNoticeBody(repo, state, text);
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		say(`${STANDING_WORKLOAD_ID}: ${body}`);
	};
	const marker = (repo: string, raised: string) => `<!-- train-notice protection ${repo} ${raised} -->`;
	for (const ep of protectionEpisodes(ledger).values()) if (ep.raised) read.add(ep.repo);
	const wake = new Map<string, string>();
	for (const repo of [...read].sort()) {
		try {
			const p = protectionGap(repo, ghJson);
			const text = (p.state === "ok" ? "verified" : p.text).replace(/\s+/g, " ").trim();
			const last = protectionEpisodes(ledger).get(repo)?.read ?? null;
			// One row per change among ok, unknown and gap; a gap whose text changed is a new gap row.
			if (last === null || last.state !== p.state || (p.state === "gap" && last.text !== text)) write(repo, p.state, text);
			let ep = protectionEpisodes(ledger).get(repo)!;
			if (p.state === "ok") {
				if (ep.raised === null) continue;
				const url = ep.issue ?? ops.marked(marker(repo, ep.raised.id));
				if (url !== null) closeNotice(ops, ghJson, url, `Main's protection on ${repo} verifies again; the merge train goes on (as2).`);
				write(repo, "cleared", `verified again${url === null ? "" : `; ${url} closed`}`);
				for (const t of openTrains(ledger)) {
					if (repoOf(t) === repo && protectionPassOvers(ledger, t).size > 0) wake.set(t, `main protection on ${repo} verified again`);
				}
				continue;
			}
			if (ep.raised === null) {
				if (ep.read!.state === "unknown" && Date.parse(ledger.now()) - Date.parse(ep.read!.createdAt) < PROTECTION_UNKNOWN_RAISE_MS) continue;
				write(repo, "raised", text);
				ep = protectionEpisodes(ledger).get(repo)!;
			}
			if (ep.issue === null) {
				const url = fileNotice(ops, marker(repo, ep.raised!.id), `merge train: main protection on ${repo} is unverified`, [
					`Main's protection on ${repo} could not be verified (${ep.read!.state}): ${ep.text}`,
					"",
					"The merge train passes its normal-stakes PRs over (no merge, no question) until it verifies; the train tick reads it every pass.",
					"This issue closes itself when the protection verifies again.",
				].join("\n"));
				write(repo, "filed", url);
			}
		} catch (err) {
			say(`${STANDING_WORKLOAD_ID}: protection ${repo}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { wake, open: new Set([...protectionEpisodes(ledger).values()].filter((e) => e.raised !== null).map((e) => e.repo)) };
}

/**
 * Step 3d (D7): each valid holder `main-red:` row raises once per url (`raised`, the needs-you line), its jo-issues issue is filed
 * once (`filed`), and once the main-red issue is CLOSED the jo-issues issue is closed and `cleared` written. A url that is no
 * issue on the train's own repository is logged only.
 */
function mainRedPass(d: TickDeps, ghJson: (args: string[]) => unknown, ops: IssueOps, say: (line: string) => void): void {
	const { ledger } = d;
	const write = (url: string, state: "raised" | "filed" | "cleared", text: string) => {
		const body = mainRedNoticeBody(url, state, text);
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		say(`${STANDING_WORKLOAD_ID}: ${body}`);
	};
	const seen = new Set(mainRedNotices(ledger).keys());
	for (const r of mainRedRows(ledger)) {
		if (!r.valid) {
			say(`${r.train}: main-red ${r.url} (${r.entryId}) is not an issue on ${r.repo ?? "the train's repository"}: not raised`);
			continue;
		}
		if (seen.has(r.url)) continue;
		seen.add(r.url);
		write(r.url, "raised", `run ${r.run}`);
	}
	for (const n of mainRedNotices(ledger).values()) {
		if (n.cleared !== null) continue;
		try {
			const [, repo, num] = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(n.url)!;
			let issue = n.issue;
			if (issue === null) {
				issue = fileNotice(ops, `<!-- train-notice main-red ${n.url} -->`, `merge train: main is red on ${repo}`, [
					`Main is red on ${repo}: ${n.url} (merge train run ${n.run}).`,
					"",
					"The merge train keeps merging PRs that add no failure (red-main); this issue closes itself when that issue closes.",
				].join("\n"));
				write(n.url, "filed", issue);
			}
			if (field(ghJson(["issue", "view", num!, "-R", repo!, "--json", "state"]), "state") !== "CLOSED") continue;
			closeNotice(ops, ghJson, issue, `${n.url} is closed (as2).`);
			write(n.url, "cleared", `${n.url} closed`);
		} catch (err) {
			say(`${STANDING_WORKLOAD_ID}: main-red ${n.url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** What step 3f found, for the wakes (step 4) and the `train-reconciled:` entries written after them. */
interface LandResult {
	/** Trains to wake: landing reopened on their repository and they passed a PR over while it was stopped. */
	wake: Map<string, string>;
	/** Land-first repositories whose landing is stopped: their landing pass-overs get no backoff wake. */
	stopped: Set<string>;
	/** The open train to wake for each regression's repair (D7), until its `repair-woken` row is written. */
	repairs: Map<string, { repo: string; tip: string }>;
	/** Each land-first repository whose pass read main and wrote every row it owed: what its `train-reconciled:` says. */
	reconcile: { repo: string; state: MainState; read: string | null; repair: string | null }[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** A process's last output line, for a log line or a row. */
const lastLine = (r: GhResult) => ((r.stdout.trim() || r.stderr.trim()).split("\n").at(-1) ?? "").trim() || "no output";
const SHA40 = /^[0-9a-f]{40}$/;

/** One land-first row (`landFirstNoticeBody`) on the standing workload as MERGE_TRAIN_BY, and its log line. */
function landNote(d: Pick<TickDeps, "ledger">, say: (line: string) => void, repo: string, e: LandFirstEvent): void {
	const body = landFirstNoticeBody(repo, e);
	d.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
	say(`${STANDING_WORKLOAD_ID}: ${body}`);
}

/** The test runner's served repositories (`testRunner.repos`) as lowercase `owner/repo`, each once; an origin naming none is logged. */
function servedRepos(config: TickDeps["config"], say: (line: string) => void): string[] {
	const out = new Set<string>();
	for (const r of config?.repos ?? []) {
		const repo = ownerRepoOf(r.origin);
		if (repo === null) say(`land-first: testRunner origin ${r.origin} names no GitHub repository: no main runs for it`);
		else out.add(repo.toLowerCase());
	}
	return [...out].sort();
}

/** Main's tip on GitHub: `gh api repos/<repo>/git/ref/heads/main`'s sha. */
function mainTip(repo: string, ghJson: (args: string[]) => unknown): string {
	const path = `repos/${repo}/git/ref/heads/${DEFAULT_BRANCH}`;
	const sha = field(field(ghJson(["api", path]), "object"), "sha");
	if (typeof sha !== "string" || !SHA40.test(sha)) throw new GhError(`gh api ${path} returned an unexpected shape`);
	return sha;
}

/**
 * Step 3f (PLAN wl-mvq4edbaf13vnk D6), on the standing workload. Reap first (`test-runner.ts reap`). Then per served repository,
 * land-first on or not (§ 2 Bootstrap, shadow mode): main's tip and chain (`ghMainChain`), its state (`mainState`), a main run
 * requested when the tip has no verdict (`requestMain`), and, for the tick's own control repository, promotion reconciled
 * (`promotePass`). Only with land-first on: the stop episode, its issue and notice, the repair wake, revocation and the
 * reopen wake (`landingPass`), and a `train-reconciled:` to write after step 4 (`reconcile`). A repository whose main cannot be
 * read is logged and gets no `train-reconciled:` this pass (F7).
 */
function landPass(
	d: TickDeps, land: LandDeps, ghJson: (args: string[]) => unknown, ops: IssueOps, say: (line: string) => void, repoOf: (wl: string) => string | null, served: string[],
	root: ControlRoot | null,
): LandResult {
	const { ledger } = d;
	const res: LandResult = { wake: new Map(), stopped: new Set(), repairs: new Map(), reconcile: [] };
	if (served.length === 0) return res;
	const reap = land.runner(["reap"]);
	if (reap.code !== 0) say(`land-first: bun surface/scripts/test-runner.ts reap exited ${reap.code}: ${lastLine(reap)} — no main run is requested this pass; the next pass reaps again`);
	// The watermark (§ 2): the newest main-run settle this pass read, after the reap's.
	const results = mainResults(ledger.entries(STANDING_WORKLOAD_ID));
	const read = results.at(-1)?.entryId ?? null;
	const greens = new Set([...mainVerdicts(results).values()].filter((v) => v.verdict === "green").map((v) => v.sha));
	for (const repo of served) {
		// Off reconciliation does not depend on main being readable, green or even requested this pass.
		if (!reconcileLandFirstOff(d, repo, land.runsRoot ?? runsRoot(process.env), repoOf, say)) {
			res.stopped.add(repo);
			continue;
		}
		try {
			const tip = mainTip(repo, ghJson);
			const chain: ChainCommit[] = ghMainChain(repo, tip, ghJson, greens);
			const state = mainState(chain, results, Date.parse(ledger.now()));
			if (reap.code === 0) requestMain(d, land, say, repo, tip, results);
			if (root !== null && root.repo === repo) promotePass(d, land, ops, say, repo, state, root);
			if (!landFirstOn(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), repo)) continue;
			const repair = landingPass(d, ghJson, ops, say, repoOf, repo, state, results, res);
			res.reconcile.push({ repo, state, read, repair });
		} catch (err) {
			say(`land-first ${repo}: ${errText(err)} — no train-reconciled written this pass; the next pass reads main again`);
		}
	}
	return res;
}

/**
 * Discover workloads and their repositories outside the publication mutex. Each head serializes a
 * fresh ledger-only provenance/activation read and one deadline-clipped POST; completion only the known ids.
 * Scheduled ticks are the only retry layer: three attempts per newest off instruction, then held
 * until repair and an explicit new `land-first <repo> off` word. Off receipts never count as
 * landingPass revocation failures.
 */
export function reconcileLandFirstOff(
	d: Pick<TickDeps, "ledger" | "gh">, repo: string, root: string, repoOf: (wl: string) => string | null, say: (line: string) => void,
): boolean {
	const { ledger } = d;
	const pending = () => landFirstOffPending(ledger.entries(STANDING_WORKLOAD_ID), ledger.instructions(STANDING_WORKLOAD_ID), repo);
	const ids = pending();
	if (ids.length === 0) return true;
	const block = ids.at(-1)!;
	const attemptPrefix = `off-reconcile-attempt: ${repo} ${block} `;
	const repair = `merges held; repair the named failure, then issue land-first ${repo} off again to begin a fresh retry block`;
	// Exact repeated failure receipts are deduplicated within a block, even across other errors.
	const receipt = (detail: string) => {
		const body = `train-error: off reconciliation pending for ${repo}: block ${block}: ${detail.replace(/\s+/g, " ").trim()}`;
		ledger.write(() => {
			if (!ledger.entries(STANDING_WORKLOAD_ID, "assumption").some((e) => e.created_by === MERGE_TRAIN_BY && e.body === body)) {
				ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
			}
		});
		say(body);
	};
	const attempts = ledger.write(() => {
		const tried = ledger.entries(STANDING_WORKLOAD_ID, "assumption").filter((e) => e.created_by === MERGE_TRAIN_BY && e.body.startsWith(attemptPrefix)).length;
		if (tried < REVOKE_ATTEMPTS) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${attemptPrefix}${tried + 1}` });
		return tried;
	});
	if (attempts >= REVOKE_ATTEMPTS) {
		receipt(`OffReconciliationExhausted: ${REVOKE_ATTEMPTS} attempts exhausted; ${repair}`);
		return false;
	}
	try {
		// Drain any publisher that read on before the off word. Otherwise the scan could observe
		// pending, skip that head, then complete off after the old publisher finally posts success.
		const scan = withFullSuitePublication(root, repo, (remainingMs) => {
			remainingMs();
			return pending().some((id) => ids.includes(id));
		});
		if (!scan) return pending().length === 0;
		const ghJson = (args: string[]): unknown => {
			const r = d.gh(args);
			if (r.code !== 0) throw new GhError(`gh ${args.join(" ")} exited ${r.code}: ${lastLine(r)}`);
			try {
				return JSON.parse(r.stdout);
			} catch (error) {
				throw new GhError(`gh ${args.join(" ")} returned invalid JSON: ${errText(error)}`);
			}
		};
		const open = openHeads(repo, ghJson, true);
		// Include closed workloads: their unmerged PRs can still have usable required statuses.
		const workloads = ledger.db.query<{ workload_id: string }, []>(
			"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND created_by = 'test-runner' AND body LIKE 'test-requested: %'",
		).all();
		const origins = new Map(workloads.map(({ workload_id: wl }) => [wl, repoOf(wl)]));
		let failed = false;
		for (const [pr, head] of open) {
			try {
				if (newestGateStatus(repo, head, ghJson, true)?.state !== "success") continue;
				// Discovery is not authority: a full run can settle and publish while statuses are read.
				const revoked = withFullSuitePublication(root, repo, (remainingMs) => {
					const entries = ledger.entries(STANDING_WORKLOAD_ID);
					const instructions = ledger.instructions(STANDING_WORKLOAD_ID);
					const current = landFirstOffPending(entries, instructions, repo);
					if (!ids.some((id) => current.includes(id)) || landFirstOn(entries, instructions, repo)) return false;
					const kind = offHeadAuthority(ledger, repo, pr, head, origins);
					if (kind === "full") return false;
					if (kind !== "fast") throw new Error(`cannot identify whether #${pr} ${head}'s success is a full result or fast/tree plan; repair its runner provenance`);
					const r = d.gh(["api", "-X", "POST", `repos/${repo}/statuses/${head}`, "-f", "state=failure", "-f", `context=${FULL_SUITE_STATUS}`, "-f", "description=land-first off: fast/tree success revoked; request the full suite"], remainingMs());
					if (r.code !== 0) throw new GhError(`gh status revoke #${pr} ${head} exited ${r.code}: ${lastLine(r)}`);
					return true;
				});
				if (revoked) say(`land-first ${repo}: off reconciliation revoked #${pr} ${head}`);
			} catch (error) {
				failed = true;
				try {
					receipt(`#${pr} ${head}: ${errText(error)}; merges held; next scheduled tick retries within this instruction's attempt limit`);
				} catch (receiptError) {
					throw new AggregateError([error, receiptError], `off reconciliation #${pr} ${head} failed: ${errText(error)}; failure receipt also failed: ${errText(receiptError)}`);
				}
			}
		}
		if (failed) {
			if (attempts + 1 >= REVOKE_ATTEMPTS) receipt(`OffReconciliationExhausted: ${REVOKE_ATTEMPTS} attempts exhausted; ${repair}`);
			return false;
		}
		// Every publisher re-reads activation under this mutex; pending off forbids new fast/tree
		// successes. Thus listing may be outside it, and this bounded completion cannot clear new ids.
		const complete = withFullSuitePublication(root, repo, (remainingMs) => {
			remainingMs();
			ledger.write(() => {
				const current = pending();
				for (const id of ids.filter((id) => current.includes(id))) {
					const instruction = ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === id)!;
					const wordRepo = instruction.body.split(" ")[1]!;
					ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstOffBody(wordRepo, "complete", id) });
				}
			});
			return pending().length === 0;
		});
		say(`land-first ${repo}: off reconciliation completed for ${ids.join(", ")}${complete ? "; fast/tree successes revoked, full results preserved" : "; a newer off remains pending"}`);
		return complete;
	} catch (error) {
		try {
			receipt(`${errText(error)}; merges held; next scheduled tick retries within this instruction's attempt limit`);
			if (attempts + 1 >= REVOKE_ATTEMPTS) receipt(`OffReconciliationExhausted: ${REVOKE_ATTEMPTS} attempts exhausted; ${repair}`);
		} catch (receiptError) {
			throw new AggregateError([error, receiptError], `off reconciliation for ${repo} failed: ${errText(error)}; failure receipt could not be persisted: ${errText(receiptError)}`);
		}
		return false;
	}
}

/**
 * Read only this head's runner authority at serialization. Repository discovery stays outside the
 * lock; a newly appearing workload has unknown origin until the next scheduled pass, never stale
 * fast authority. Copied full/Mac counts must trace to a genuine full source, not a tree/fast plan.
 */
function offHeadAuthority(ledger: Ledger, repo: string, pr: number, head: string, origins: ReadonlyMap<string, string | null>): "fast" | "full" | "unknown" {
	const owners = ledger.db.query<{ workload_id: string }, [string]>(
		"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND created_by = 'test-runner' AND body LIKE ?",
	).all(`test-requested: % pr=${pr} sha=${head} %`);
	let kind: "fast" | "unknown" = "unknown";
	let uncertain = false;
	for (const { workload_id: wl } of owners) {
		const origin = origins.get(wl);
		if (origin === undefined || origin === null) {
			uncertain = true;
			continue;
		}
		if (!sameRepo(origin, repo)) continue;
		const rows = ledger.entries(wl);
		const records = testRuns(rows);
		const plans = fastPlans(rows);
		for (const run of records) {
			if (run.request.pr !== pr || run.request.sha !== head || run.result === null) continue;
			let source = run.result;
			let plan = plans.get(source.runId);
			const seen = new Set<string>();
			for (;;) {
				if (plan?.scope === "tree" || plan?.scope === "fast" || source.scope === "fast" || source.reason?.startsWith("carried from main run ")) {
					kind = "fast";
					break;
				}
				if (source.scope !== "full" || source.host !== "mac" || (source.verdict !== "green" && source.verdict !== "red-main") || seen.has(source.runId)) {
					uncertain = true;
					break;
				}
				seen.add(source.runId);
				const carried = /^carried from (tr-[a-z0-9]+) at [0-9a-f]{40} \(decision-log only\)$/.exec(source.reason ?? "");
				if (carried === null) {
					if (!source.reason?.startsWith("carried from ")) return "full";
					uncertain = true;
					break;
				}
				// Source requests may live on a different workload. Only previously discovered,
				// same-repository owners establish provenance; missing/cyclic chains fail closed.
				const sources = ledger.db.query<{ workload_id: string }, [string]>(
					"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND created_by = 'test-runner' AND body LIKE ?",
				).all(`test-requested: ${carried[1]} %`);
				if (sources.length !== 1) {
					uncertain = true;
					break;
				}
				const owner = sources[0]!.workload_id;
				const sourceOrigin = origins.get(owner);
				if (sourceOrigin === undefined || sourceOrigin === null || !sameRepo(sourceOrigin, repo)) {
					uncertain = true;
					break;
				}
				const sourceRows = ledger.entries(owner);
				const previous = testRuns(sourceRows).find((r) => r.request.runId === carried[1])?.result;
				if (!previous) {
					uncertain = true;
					break;
				}
				source = previous;
				plan = fastPlans(sourceRows).get(source.runId);
			}
		}
	}
	return uncertain ? "unknown" : kind;
}

/**
 * D6's main-run request for tip `tip`: none when it has a verdict; when its attempt block is exhausted (`attemptBlock`, reopened
 * only by Jo's `main-retry:`), one `exhausted` row per block and no request; when its last run was inconclusive, only once that
 * run is MAIN_RETRY_MS old; otherwise `test-runner.ts main --repo <repo> --sha <tip>` (the runner answers 0 doing nothing while
 * that tip is already its active or pending main run). A refused request is logged; the next pass asks again.
 */
function requestMain(d: TickDeps, land: LandDeps, say: (line: string) => void, repo: string, tip: string, results: readonly ResultRecord[]): void {
	const { ledger } = d;
	if (mainVerdicts(results).has(tip)) return;
	const entries = ledger.entries(STANDING_WORKLOAD_ID);
	const block = attemptBlock(tip, results, mainRetries(entries, ledger.instructions(STANDING_WORKLOAD_ID), repo));
	if (block.exhausted) {
		if (!landFirstRows(entries, repo).some((r) => r.event === "exhausted" && r.sha === tip && r.block === block.block)) landNote(d, say, repo, { event: "exhausted", sha: tip, block: block.block });
		return;
	}
	const last = results.findLast((r) => r.sha === tip);
	if (last !== undefined && INCONCLUSIVE.includes(last.verdict) && Date.parse(ledger.now()) - Date.parse(last.createdAt) < MAIN_RETRY_MS) return;
	const r = land.runner(["main", "--repo", repo, "--sha", tip]);
	say(`land-first ${repo}: main run at ${tip.slice(0, 7)} (attempt block ${block.block}, ${block.attempts} inconclusive): test-runner main exited ${r.code}: ${lastLine(r)}`);
}

/** The `as2-verified` tag's commit on `repo`; null when the tag does not exist (gh answers 404). */
function verifiedTag(d: TickDeps, repo: string): string | null {
	const path = `repos/${repo}/git/ref/tags/${AS2_VERIFIED_TAG}`;
	const r = d.gh(["api", path]);
	if (r.code !== 0) {
		if (/HTTP 404|Not Found/.test(`${r.stderr}\n${r.stdout}`)) return null;
		throw new GhError(`gh api ${path} exited ${r.code}: ${lastLine(r)}`);
	}
	let json: unknown;
	try {
		json = JSON.parse(r.stdout);
	} catch {
		throw new GhError(`gh api ${path} did not return json`);
	}
	const object = field(json, "object");
	const sha = field(object, "sha");
	if (field(object, "type") !== "commit" || typeof sha !== "string" || !SHA40.test(sha)) throw new GhError(`gh api ${path} does not name a commit (an annotated or misshapen tag)`);
	return sha;
}

/**
 * § 2 "Promotion is reconciled" (R31), the tick's control repository only, land-first on or not: while `verified/current` or
 * the `as2-verified` tag lags G, `test-runner.ts promote --sha <G>` (idempotent) once per pass, at most PROMOTE_ATTEMPTS
 * failures per G (each a `promote-failed` row, the last also `promote-gave-up`), meanwhile running from the current root. An
 * answer `schema <sha>` (it stopped before that schema-changing commit) files one issue and writes `promote-schema`; no further
 * call until `current` moves (Jo's reserved promotion). A success after a failure or a schema wait writes `promote-ok`, which
 * clears the render's verifier line.
 */
function promotePass(d: TickDeps, land: LandDeps, ops: IssueOps, say: (line: string) => void, repo: string, state: MainState, root: ControlRoot): void {
	const { ledger } = d;
	const g = state.g;
	if (g === null) return;
	try {
		const tag = verifiedTag(d, repo);
		if (root.currentHead === g && tag === g) return;
		const rows = landFirstRows(ledger.entries(STANDING_WORKLOAD_ID), repo);
		const settled = rows.findLast((r) => r.event === "promote-schema" || r.event === "promote-ok");
		if (settled?.event === "promote-schema" && settled.current === root.currentHead && settled.g === g) return;
		const fails = rows.filter((r) => r.event === "promote-failed" && r.g === g).length;
		if (fails >= PROMOTE_ATTEMPTS) return;
		const r = land.runner(["promote", "--sha", g]);
		const line = lastLine(r);
		const m = /^(promoted|schema) ([0-9a-f]{40})$/.exec(line);
		if (r.code === 0 && m?.[1] === "promoted" && m[2] === g) {
			const since = rows.findLast((x) => x.event === "promote-ok")?.createdAt ?? "";
			if (rows.some((x) => (x.event === "promote-failed" || x.event === "promote-gave-up" || x.event === "promote-schema") && x.createdAt >= since)) landNote(d, say, repo, { event: "promote-ok", g });
			else say(`land-first ${repo}: promoted ${g.slice(0, 7)} (current and the tag)`);
			return;
		}
		if (r.code === 0 && m?.[1] === "schema") {
			const sha = m[2]!;
			const url = fileNotice(ops, `<!-- train-notice land-first ${repo} promote-schema ${sha} target ${g} -->`, `verifier: promotion on ${repo} waits on a schema change at ${sha.slice(0, 7)}`, [
				`Commit ${sha} on ${repo} changes a schema-migration path (ledger/schema.sql or the SCHEMA_VERSION line of ledger/src/index.ts).`,
				`Promotion stopped before it: verified/current stays at ${root.currentHead ?? "(none)"}, so the control plane keeps running on the old schema; G is ${g}.`,
				"",
				`Jo's reserved step: stop the tick, migrate the live ledger through verified target ${g} (including schema barrier ${sha}), run \`bun surface/scripts/promote-verified.ts ${g}\`, restart.`,
			].join("\n"));
			landNote(d, say, repo, { event: "promote-schema", sha, g, current: root.currentHead, issue: url });
			return;
		}
		const error = r.code === 0 ? `unexpected answer: ${line}` : `exit ${r.code}: ${line}`;
		landNote(d, say, repo, { event: "promote-failed", g, attempt: fails + 1, error });
		if (fails + 1 >= PROMOTE_ATTEMPTS) landNote(d, say, repo, { event: "promote-gave-up", g, error });
	} catch (err) {
		say(`land-first ${repo}: promotion of ${g.slice(0, 7)} not reconciled this pass: ${errText(err)}`);
	}
}

/** The open PRs of `repo` and their heads: `gh pr list --state open`. */
function openHeads(repo: string, ghJson: (args: string[]) => unknown, all = false): Map<number, string> {
	const response = all
		? ghJson(["api", `repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--slurp"])
		: ghJson(["pr", "list", "-R", repo, "--state", "open", "--json", "number,headRefOid", "--limit", "500"]);
	if (!Array.isArray(response) || (all && response.some((page) => !Array.isArray(page)))) throw new GhError(`gh open PR listing -R ${repo} returned an unexpected shape`);
	const list: unknown[] = all ? response.flat() : response;
	const out = new Map<number, string>();
	for (const p of list as unknown[]) {
		const n = field(p, "number");
		const head = all ? field(field(p, "head"), "sha") : field(p, "headRefOid");
		if (typeof n !== "number" || typeof head !== "string" || !SHA40.test(head)) throw new GhError(`gh pr list -R ${repo} returned a PR with no number or head`);
		out.set(n, head);
	}
	return out;
}

/** The newest `as2/full-suite` status on `sha` (GitHub lists a commit's statuses newest first); null when it has none. */
function newestGateStatus(repo: string, sha: string, ghJson: (args: string[]) => unknown, all = false): { state: string; description: string } | null {
	const path = `repos/${repo}/commits/${sha}/statuses`;
	const response = ghJson(["api", path, ...(all ? ["--paginate", "--slurp"] : [])]);
	if (!Array.isArray(response) || (all && response.some((page) => !Array.isArray(page)))) throw new GhError(`gh api ${path} returned an unexpected shape`);
	const list: unknown[] = all ? response.flat() : response;
	const s = (list as unknown[]).find((x) => field(x, "context") === FULL_SUITE_STATUS);
	if (s === undefined) return null;
	const state = field(s, "state");
	const description = field(s, "description");
	if (typeof state !== "string") throw new GhError(`gh api ${path} returned a status with no state`);
	return { state, description: typeof description === "string" ? description : "" };
}

/**
 * D6 and D7 for one land-first repository: landing open closes an open stop episode (its issue closed, `stop-cleared`) and
 * wakes each open train on the repository with a landing pass-over. Stopped: the episode's `stop-raised` (the one notice) or
 * `stop-updated` when its kind or tip changes (a comment on its issue), its jo-issues issue for a regression or an
 * infrastructure stop (`stop-filed`), the repair wake for a regression once per episode (the repository's open train, step 4;
 * no open train is logged and recorded `train none`), and `repair-failed` REPAIR_FAIL_MS after the wake. While stopped, every
 * open head whose newest `as2/full-suite` is a success is revoked (failure `landing stopped: …`), one attempt per head per pass,
 * REVOKE_ATTEMPTS at most, then `revoke-gave-up`; a success the gate posted as the repair (`repair: …`) is kept and returned as
 * the repair head. A given-up head that is no longer its PR's open head gets `revoke-cleared`. Throws when GitHub cannot answer.
 */
function landingPass(
	d: TickDeps, ghJson: (args: string[]) => unknown, ops: IssueOps, say: (line: string) => void, repoOf: (wl: string) => string | null, repo: string, state: MainState,
	results: readonly ResultRecord[], res: LandResult,
): string | null {
	const { ledger } = d;
	// Preserve the decision's ledger dependencies through discovery, without holding a network lock.
	const activation = controlEntries(ledger.entries(STANDING_WORKLOAD_ID))
		.filter((c) => c.prefix === "land-first" && sameRepo(c.rest.split(" ")[0]!, repo)).map((c) => c.id).join(" ");
	const watermark = results.at(-1)?.entryId ?? null;
	const rows = () => landFirstRows(ledger.entries(STANDING_WORKLOAD_ID), repo);
	const sha7 = (s: string) => s.slice(0, 7);
	const suspects = [...new Set(state.suspects.flatMap((s) => s.prs))].sort((a, b) => a - b);
	let ep = stopEpisode(rows());
	if (state.open) {
		if (ep !== null) {
			if (ep.filed !== null) closeNotice(ops, ghJson, ep.filed, `Landing on ${repo} reopened at ${sha7(state.tip)} (G ${sha7(state.g!)}) (as2).`);
			landNote(d, say, repo, { event: "stop-cleared", why: `landing open at ${sha7(state.tip)}, G ${sha7(state.g!)}` });
			for (const t of openTrains(ledger)) if (repoOf(t) === repo && landingPassOvers(ledger, t).size > 0) res.wake.set(t, `landing reopened on ${repo}`);
		}
	} else {
		res.stopped.add(repo);
		const kind = state.stop!;
		const red = state.suspects.find((s) => s.verdict !== null && s.verdict.verdict !== "green");
		const redRun = red?.verdict ? (results.find((r) => r.runId === red.verdict!.runId) ?? null) : null;
		const stop = { kind, tip: state.tip, g: state.g, suspects, failing: redRun === null ? null : (redRun.full?.fail ?? redRun.failures.length) };
		const body = () => issueBody(ledger, repo, state, suspects, redRun, repoOf);
		if (ep === null) {
			landNote(d, say, repo, { event: "stop-raised", ...stop });
			ep = stopEpisode(rows())!;
		} else if (ep.state.kind !== kind || ep.state.tip !== state.tip) {
			landNote(d, say, repo, { event: "stop-updated", ...stop });
			if (ep.filed !== null) ops.run(["issue", "comment", issueNumber(ep.filed), "-R", TRAIN_ALERT_REPO, "--body", `Updated (as2):\n${body()}`]);
			ep = stopEpisode(rows())!;
		}
		if (kind !== "depth" && ep.filed === null) {
			const url = fileNotice(ops, `<!-- train-notice land-first ${repo} ${ep.raised.entryId} -->`, `landing stopped on ${repo} (${kind}) at ${sha7(state.tip)}`, body());
			landNote(d, say, repo, { event: "stop-filed", url });
		}
		if (kind === "regression" && ep.woken === null) {
			const train = openTrains(ledger).find((t) => repoOf(t) === repo);
			if (train !== undefined) res.repairs.set(train, { repo, tip: state.tip });
			else {
				landNote(d, say, repo, { event: "repair-woken", tip: state.tip, train: null });
				say(`land-first ${repo}: no open merge train to wake for the repair of ${sha7(state.tip)}: an owner's fix PR or Jo repairs it`);
			}
		}
		if (ep.woken !== null && ep.failed === null && Date.parse(ledger.now()) - Date.parse(ep.woken.createdAt) >= REPAIR_FAIL_MS) {
			landNote(d, say, repo, { event: "repair-failed", tip: ep.woken.tip, woken: ep.woken.createdAt });
		}
	}
	const gaveUp = new Map<string, { pr: number; head: string }>();
	for (const r of rows()) {
		if (r.event === "revoke-gave-up") gaveUp.set(`${r.pr} ${r.head}`, r);
		else if (r.event === "revoke-cleared") gaveUp.delete(`${r.pr} ${r.head}`);
	}
	if (state.open && gaveUp.size === 0) return null;
	const open = openHeads(repo, ghJson);
	for (const g of gaveUp.values()) {
		const now = open.get(g.pr);
		if (now !== g.head) landNote(d, say, repo, { event: "revoke-cleared", pr: g.pr, head: g.head, why: now === undefined ? "the PR is no longer open" : `its head is now ${sha7(now)}` });
	}
	if (state.open) return null;
	let repair: string | null = null;
	const stopped = `landing stopped: ${state.reasons.join("; ")}`;
	// GitHub refuses a status description over 140 characters.
	const description = stopped.length > 140 ? `${stopped.slice(0, 139)}…` : stopped;
	for (const [n, head] of open) {
		const st = newestGateStatus(repo, head, ghJson);
		if (st?.state !== "success") continue;
		if (st.description.startsWith("repair:")) {
			if (repair === null) repair = head;
			else say(`land-first ${repo}: #${n} at ${sha7(head)} is a second repair success; only ${sha7(repair)} is named`);
			continue;
		}
		// Older off reconcilers used this event too; their failures are not landing-stop attempts.
		const tried = rows().filter((r) => r.event === "revoke-failed" && r.pr === n && r.head === head && !r.error.startsWith("off reconciliation pending:")).length;
		if (tried >= REVOKE_ATTEMPTS) continue;
		try {
			const revoked = withFullSuitePublication(d.land!.runsRoot ?? runsRoot(process.env), repo, (remainingMs) => {
				const entries = ledger.entries(STANDING_WORKLOAD_ID);
				const currentActivation = controlEntries(entries)
					.filter((c) => c.prefix === "land-first" && sameRepo(c.rest.split(" ")[0]!, repo)).map((c) => c.id).join(" ");
				if (!landFirstOn(entries, ledger.instructions(STANDING_WORKLOAD_ID), repo)
					|| currentActivation !== activation || (mainResults(entries).at(-1)?.entryId ?? null) !== watermark) {
					say(`land-first ${repo}: skipped stale landing revocation #${n} ${head}; activation or main authority changed, next tick recomputes`);
					return false;
				}
				const r = d.gh(["api", "-X", "POST", `repos/${repo}/statuses/${head}`, "-f", "state=failure", "-f", `context=${FULL_SUITE_STATUS}`, "-f", `description=${description}`], remainingMs());
				if (r.code !== 0) throw new GhError(`gh status revoke #${n} ${head} exited ${r.code}: ${lastLine(r)}`);
				return true;
			});
			if (revoked) say(`land-first ${repo}: revoked #${n} at ${sha7(head)}: ${description}`);
		} catch (err) {
			const error = errText(err);
			try {
				landNote(d, say, repo, { event: "revoke-failed", pr: n, head, attempt: tried + 1, error });
				if (tried + 1 >= REVOKE_ATTEMPTS) landNote(d, say, repo, { event: "revoke-gave-up", pr: n, head, error });
			} catch (receiptError) {
				throw new AggregateError([err, receiptError], `landing revocation #${n} ${head} failed: ${error}; failure receipt also failed: ${errText(receiptError)}`);
			}
		}
	}
	return repair;
}

/** A stop episode's jo-issues issue body (D6): the summary, G, each suspect with its PRs, workload and main run, the failing tests. */
function issueBody(ledger: Ledger, repo: string, state: MainState, suspects: number[], redRun: ResultRecord | null, repoOf: (wl: string) => string | null): string {
	const owner = (n: number): string | null => {
		for (const t of everyTrain(ledger)) {
			if (repoOf(t) !== repo) continue;
			const b = trainBindings(ledger.entries(t), ledger.instructions(t)).findLast((x) => x.source === "board" && x.prs.includes(n));
			if (b?.board) return b.board.workload;
		}
		return null;
	};
	const lines = [stopSummary(repo, { kind: state.stop!, tip: state.tip, g: state.g, suspects, reasons: state.reasons }), "", `G (verified): ${state.g ?? "none in the commits read"}`, "", "Suspects (oldest first):"];
	for (const s of state.suspects) {
		const prs = s.prs.length === 0 ? "no PR" : s.prs.map((n) => `#${n} (${owner(n) ?? "workload unknown"})`).join(", ");
		const run = s.lastRun === null ? "no main run yet" : `main run ${s.lastRun.runId} ${s.lastRun.verdict}${s.lastRun.runDir ? ` ${s.lastRun.runDir}` : ""}`;
		lines.push(`- ${s.sha} landed ${s.date}: ${prs}; verdict ${s.verdict?.verdict ?? "none"}; ${run}`);
	}
	if (redRun !== null) {
		lines.push("", `Failing tests (run ${redRun.runId}${redRun.runDir ? `, ${redRun.runDir}` : ""}):`);
		for (const f of redRun.failures.slice(0, 30)) lines.push(`- ${f.name}: ${f.firstError}`);
		if (redRun.failures.length > 30) lines.push(`- … ${redRun.failures.length - 30} more in the run's result.json`);
		lines.push("", `Attribution: the runner's main-red row for run ${redRun.runId} on ${STANDING_WORKLOAD_ID} names the suspects whose changes reach a failing test.`);
	}
	return lines.join("\n");
}

/**
 * The `train-reconciled:` entries of step 3f (D6, R18), after step 4 wrote the wakes they owed: per land-first repository whose
 * pass read main and wrote every row it owed (`landPass`), in one write transaction that first checks the newest main-run settle
 * is still the one the pass read (its watermark); when a newer one landed, nothing is written and the next pass recomputes.
 */
function reconcile(d: TickDeps, land: LandResult, say: (line: string) => void): void {
	const { ledger } = d;
	for (const c of land.reconcile) {
		const wrote = ledger.write((): string | null => {
			const newest = mainResults(ledger.entries(STANDING_WORKLOAD_ID)).at(-1)?.entryId ?? null;
			if (newest !== c.read) return null;
			const body = trainReconciledBody({
				repo: c.repo, at: ledger.now(), tip: c.state.tip, g: c.state.g, open: c.state.open, oldest: c.state.oldestMs === null ? null : new Date(c.state.oldestMs).toISOString(),
				repair: c.state.open ? null : c.repair, read: c.read, reasons: c.state.reasons.join("; "),
			});
			ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
			return body;
		});
		say(wrote === null ? `land-first ${c.repo}: no train-reconciled: a main-run settle landed after this pass read ${c.read ?? "none"}; the next pass recomputes` : `${STANDING_WORKLOAD_ID}: ${wrote}`);
	}
}

/** A PR a train merged (PLAN wl-mvg8itbt0rz3ls D4): its train, number, slice artifact and whether Jo's train word signed it off. */
interface TrainMerge {
	train: string;
	pr: number;
	artifact: string;
	production: boolean;
}

/**
 * Every PR merged by a train open now or closed within MAIN_RED_WINDOW_MS (step 3d's trains, `mainRedRows`), oldest train first,
 * in slice order: its disposition slice `sl-train-<k>-<n>` is done with an artifact starting `merged by train`. `production` when
 * a holder of the train recorded `ruling-applied: train-signoff …` on that slice (the ruling decided its merge question).
 */
function trainMerges(ledger: Ledger): TrainMerge[] {
	const since = new Date(Date.parse(ledger.now()) - MAIN_RED_WINDOW_MS).toISOString();
	const out: TrainMerge[] = [];
	for (const t of everyTrain(ledger)) {
		const w = ledger.workload(t)!;
		if (w.status === "closed" && w.closed_at! < since) continue;
		let signoffs: Set<string> | undefined;
		for (const sl of ledger.slices(t)) {
			const pr = trainSlicePr(sl.id, t);
			if (pr === null || sl.id !== trainSliceId(t, pr) || sl.state !== "done" || !sl.artifact?.startsWith("merged by train")) continue;
			if (signoffs === undefined) {
				const entries = ledger.entries(t, "assumption");
				const holders = holdersOf(entries, w.holder, ledger.holders(t));
				signoffs = new Set(entries.filter((e) => e.slice_id !== null && holders.includes(e.created_by) && e.body.startsWith(TRAIN_SIGNOFF_APPLIED_PREFIX)).map((e) => e.slice_id!));
			}
			out.push({ train: t, pr, artifact: sl.artifact, production: signoffs.has(sl.id) });
		}
	}
	return out;
}

/**
 * Step 3e (PLAN wl-mvg8itbt0rz3ls D4): for each PR a train merged (`trainMerges`), in one write unless the standing workload already
 * has it, the control entry `train-notice: merged <owner/repo> #<n> <train>` and Jo's notice, both by MERGE_TRAIN_BY. A train whose
 * repository cannot be read is logged and skipped (retried next pass).
 */
function mergeNoticePass(d: TickDeps, say: (line: string) => void, repoOf: (wl: string) => string | null): void {
	const { ledger } = d;
	for (const m of trainMerges(ledger)) {
		try {
			const repo = repoOf(m.train);
			if (repo === null) {
				say(`${m.train}: merge notice for #${m.pr}: no GitHub repository for the train's repo: not sent`);
				continue;
			}
			const entry = trainMergedEntryBody(repo, m.pr, m.train);
			const sent = ledger.write(() => {
				if (ledger.entries(STANDING_WORKLOAD_ID, "assumption").some((e) => e.created_by === MERGE_TRAIN_BY && e.body === entry)) return false;
				ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: entry });
				sendNotice(ledger, { by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, body: trainMergedNoticeBody(repo, m.pr, m.production, m.artifact) });
				return true;
			});
			if (sent) say(`${STANDING_WORKLOAD_ID}: ${entry}`);
		} catch (err) {
			say(`${m.train}: merge notice for #${m.pr}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

/** The jo-issues helpers the alerts (D9) and the notices (D6, D7) share. */
interface IssueOps {
	/** A gh call that must succeed; its stdout. */
	run: (args: string[]) => string;
	/**
	 * The url of the issue the train filed whose body carries `marker`, any state; null only when the whole listing has none. A
	 * failed or unreadable listing throws: the caller writes nothing durable and the next pass looks again.
	 */
	marked: (marker: string) => string | null;
	/**
	 * A gh call that adds labels; its stdout. A failure is retried once, and only when gh says one of `labels` is missing
	 * (`'<label>' not found`), after each label is created (one that exists already fails harmlessly). `took`, when given, is
	 * asked after every failure whether the call took effect anyway (an issue create whose reply was lost): its answer is
	 * returned and nothing is retried.
	 */
	labelled: (args: string[], labels: readonly string[], took?: () => string | null) => string;
}

function issueOps(d: TickDeps, ghJson: (args: string[]) => unknown): IssueOps {
	const failed = (args: string[], r: GhResult) =>
		new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? ""}`);
	return {
		run: (args) => {
			const r = d.gh(args);
			if (r.code !== 0) throw failed(args, r);
			return r.stdout;
		},
		marked: (marker) => {
			const pages = ghJson(ISSUE_LIST_ARGS);
			if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues returned an unexpected shape`);
			for (const i of pages.flat() as unknown[]) {
				if (typeof i !== "object" || i === null) throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues returned an unexpected shape`);
				const body = field(i, "body");
				if (typeof body !== "string" || !body.includes(marker)) continue;
				const url = field(i, "html_url");
				if (typeof url !== "string" || url === "") throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues: the issue carrying ${marker} has no html_url`);
				return url;
			}
			return null;
		},
		labelled: (args, labels, took) => {
			let r = d.gh(args);
			for (let retried = false; r.code !== 0; retried = true) {
				const done = took?.() ?? null;
				if (done !== null) return done;
				const text = `${r.stderr}\n${r.stdout}`;
				if (retried || !labels.some((l) => text.includes(`'${l}' not found`))) throw failed(args, r);
				for (const l of labels) d.gh(["label", "create", l, "-R", TRAIN_ALERT_REPO, "--description", "filed by the as2 merge train"]);
				r = d.gh(args);
			}
			return r.stdout;
		},
	};
}

/** A notice's jo-issues issue (D6, D7): the one carrying `marker` in any state, else one created with the as2-train label; its url. */
function fileNotice(ops: IssueOps, marker: string, title: string, body: string): string {
	const found = ops.marked(marker);
	if (found !== null) return found;
	const args = ["issue", "create", "-R", TRAIN_ALERT_REPO, "--label", TRAIN_ALERT_LABEL, "--title", title, "--body", `${marker}\n${body}`];
	const url = ops.labelled(args, [TRAIN_ALERT_LABEL], () => ops.marked(marker)).trim().split("\n").filter(Boolean).at(-1) ?? "";
	issueNumber(url);
	return url;
}

/** Close a notice's jo-issues issue with `comment`, unless it is closed already. */
function closeNotice(ops: IssueOps, ghJson: (args: string[]) => unknown, url: string, comment: string): void {
	const n = issueNumber(url);
	if (field(ghJson(["issue", "view", n, "-R", TRAIN_ALERT_REPO, "--json", "state"]), "state") !== "CLOSED") ops.run(["issue", "close", n, "-R", TRAIN_ALERT_REPO, "--comment", comment]);
}

/** One alert action's effects (D9's send ladder, or the close after Jo's answer). */
function alert(d: TickDeps, facts: TrainFacts, a: AlertAction, ghJson: (args: string[]) => unknown, say: (line: string) => void): void {
	const { ledger } = d;
	const { q, pr, reason, options, record } = a.alert;
	const write = (body: string) => ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: facts.wl, kind: "assumption", body });
	const { run, marked, labelled } = issueOps(d, ghJson);
	if (a.kind === "close") {
		const answer = q.resolved_by ? ledger.instructions(facts.wl).find((i) => i.id === q.resolved_by)?.body.trim() : undefined;
		const why = q.state === "answered" ? `Jo answered ${answer ?? "it"}` : `Jo ${q.state} it`;
		// No url: level 1 was begun and not finished, so its issue is found by its marker in the whole listing, or was never filed.
		const url = record.url ?? marked(trainAlertMarker(q.id, 1));
		if (url === null) {
			write(trainAlertEndBody(q.id, "closed", `${why}; no issue was filed`));
			say(`${facts.wl}: alert ${q.id} settled (${why}) before its issue was filed`);
			return;
		}
		const n = issueNumber(url);
		const state = field(ghJson(["issue", "view", n, "-R", TRAIN_ALERT_REPO, "--json", "state"]), "state");
		if (state !== "CLOSED") run(["issue", "close", n, "-R", TRAIN_ALERT_REPO, "--comment", `${why} (${q.id}) in as2.`]);
		write(trainAlertEndBody(q.id, "closed", why));
		say(`${facts.wl}: alert ${q.id} settled (${why}): issue #${n} closed`);
		return;
	}
	const level = a.level;
	const marker = trainAlertMarker(q.id, level);
	const prUrl = `https://github.com/${facts.repo}/pull/${pr}`;
	if (level === 1) {
		if (!record.sending.has(1)) write(trainAlertBody(q.id, 1, "sending"));
		let url = marked(marker) ?? "";
		if (url === "") {
			const body = [
				marker,
				`Merge train ${facts.wl} on ${facts.repo}: ${prUrl} needs you (${reason}).`,
				"",
				`Question ${q.id}; answer it in the as2 session with one word: ${options.join(" / ")}.`,
				"",
				q.body,
				"",
				`Closing this issue acknowledges the alert and stops the re-sends at 4 h and 8 h; it does not answer ${q.id}.`,
			].join("\n");
			const args = ["issue", "create", "-R", TRAIN_ALERT_REPO, "--label", TRAIN_ALERT_LABEL, "--title", `merge train: #${pr} needs you (${reason})`, "--body", body];
			const created = labelled(args, [TRAIN_ALERT_LABEL], () => marked(marker));
			url = created.trim().split("\n").filter(Boolean).at(-1) ?? "";
			issueNumber(url);
		}
		write(trainAlertBody(q.id, 1, "sent", url));
		say(`${facts.wl}: alert ${q.id} (#${pr}, ${reason}) level 1: ${url}`);
		return;
	}
	const n = issueNumber(record.url!);
	const step = TRAIN_ALERT_LADDER.find((s) => s.level === level)!;
	const hours = step.afterMs / 3_600_000;
	const issue = ghJson(["issue", "view", n, "-R", TRAIN_ALERT_REPO, "--json", "state,comments"]);
	const comments = field(issue, "comments");
	if (field(issue, "state") === "CLOSED") {
		write(trainAlertEndBody(q.id, "acked", `issue #${n} closed`));
		say(`${facts.wl}: alert ${q.id} acknowledged: issue #${n} closed`);
		return;
	}
	if (!record.sending.has(level)) write(trainAlertBody(q.id, level, "sending"));
	if (!(Array.isArray(comments) && comments.some((c) => {
		const body = field(c, "body");
		return typeof body === "string" && body.includes(marker);
	}))) {
		run(["issue", "comment", n, "-R", TRAIN_ALERT_REPO, "--body", `${marker}\n${TRAIN_ALERT_MENTION} unacknowledged ${hours} h: ${prUrl} still needs you (${reason}). Question ${q.id}: ${options.join(" / ")}. Close this issue to acknowledge.`]);
	}
	labelled(["issue", "edit", n, "-R", TRAIN_ALERT_REPO, "--add-label", step.labels.join(",")], step.labels);
	if (!record.notified.has(level)) {
		const shown = d.notify("as2 merge train", `#${pr} needs you (${reason}), unacknowledged ${hours} h: ${q.id}`);
		if (shown) write(trainAlertBody(q.id, level, "notified"));
		else say(`${facts.wl}: alert ${q.id} level ${level}: the notification could not be shown`);
	}
	write(trainAlertBody(q.id, level, "sent"));
	say(`${facts.wl}: alert ${q.id} (#${pr}) level ${level}: re-sent louder on issue #${n}`);
}

/** gh on PATH, 60 s at most, or the caller's shorter remaining publication budget. */
function realGh(args: string[], timeoutMs = 60_000): GhResult {
	const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: Math.max(1, Math.min(60_000, timeoutMs)) });
	return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.exitedDueToTimeout ? "timed out" : r.stderr.toString() };
}

/** The lane starter, awaited (it spawns the runner detached and returns). */
function realLaunch(wl: string): { code: number; line: string } {
	const r = Bun.spawnSync([process.execPath, LANE_SCRIPT, "launch", wl, "--requested-by", MERGE_TRAIN_BY], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	const lines = (r.stdout.toString().trim() || r.stderr.toString().trim()).split("\n").filter(Boolean);
	return { code: r.exitCode ?? 1, line: lines.at(-1) ?? (r.exitedDueToTimeout ? "timed out" : "no output") };
}

/** The test runner's script beside this one: the tick's own root's, so a verified tick calls a verified runner. */
const TEST_RUNNER_SCRIPT = join(import.meta.dir, "test-runner.ts");

/** `bun surface/scripts/test-runner.ts <args>`, 10 minutes at most (a promotion fetches and checks out). */
function realRunner(args: string[]): GhResult {
	const r = Bun.spawnSync([process.execPath, TEST_RUNNER_SCRIPT, ...args], { stdout: "pipe", stderr: "pipe", timeout: 600_000 });
	return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.exitedDueToTimeout ? "timed out after 600 s" : r.stderr.toString() };
}

/** `git -C <cwd> <args>`'s trimmed stdout; throws naming the command and git's error on a non-zero exit. */
function git(cwd: string, args: string[]): string {
	const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	if (r.exitCode !== 0) throw new Error(`git -C ${cwd} ${args.join(" ")} exited ${r.exitCode ?? "on a signal"}: ${r.stderr.toString().trim() || "no output"}`);
	return r.stdout.toString().trim();
}

/** The tick's own control root (§ 2 Self-checks): this checkout, its HEAD and modified tracked files, and `verified/current`. */
function realRoot(): ControlRoot {
	const root = realpathSync(git(import.meta.dir, ["rev-parse", "--show-toplevel"]));
	const head = git(root, ["rev-parse", "HEAD"]);
	const modified = git(root, ["status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean).map((l) => l.slice(3));
	const link = join(homedir(), ".agent-system-2", "verified", "current");
	let current: string | null = null;
	try {
		current = realpathSync(link);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${link} could not be resolved: ${errText(err)}`);
	}
	const origin = git(root, ["remote", "get-url", "origin"]);
	return { root, head, modified, current, currentHead: current === null ? null : git(current, ["rev-parse", "HEAD"]), repo: ownerRepoOf(origin)?.toLowerCase() ?? null };
}

/** `osascript -e 'display notification … sound name "Glass"'`. */
function realNotify(title: string, text: string): boolean {
	const str = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
	const r = Bun.spawnSync(["osascript", "-e", `display notification ${str(text)} with title ${str(title)} sound name "Glass"`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
	return r.exitCode === 0;
}

function main(argv: string[]): number {
	if (argv.length > 0) {
		process.stderr.write("usage: bun surface/scripts/train-tick.ts\n");
		return 2;
	}
	let ledger: Ledger;
	try {
		ledger = Ledger.open(defaultLedgerPath(process.env), { backupOnOpen: false });
	} catch (err) {
		process.stderr.write(`train-tick: the ledger could not be opened: ${String(err)}\n`);
		return 1;
	}
	try {
		const log = (l: string) => process.stdout.write(`${new Date().toISOString()} ${l}\n`);
		// D1 boards only on the repositories the test runner serves, read as its starter reads them.
		const cfg = loadTestRunnerConfig(process.env);
		if (!cfg.ok) log(`testRunner config unreadable (${cfg.error}): nothing boards this pass`);
		// A new fix workload's lane-model preference, read from the same file; unreadable or unset is none (today's routing).
		let trainFixModel: string | null = null;
		try {
			const pref = trainFixModelOf(Bun.YAML.parse(readFileSync(checkoutConfigPath(process.env), "utf8")));
			if (pref.problem !== null) log(pref.problem);
			trainFixModel = pref.model;
		} catch (err) {
			log(`trainFixModel unreadable (${String(err instanceof Error ? err.message : err).split("\n")[0]}): no train-fix model preference`);
		}
		tick({
			ledger, gh: realGh, launch: realLaunch, notify: realNotify, land: { runner: realRunner, root: realRoot, runsRoot: runsRoot(process.env) }, log, trainFixModel,
			...(cfg.ok ? { config: cfg.config } : {}),
		});
		return 0;
	} finally {
		ledger.close();
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
