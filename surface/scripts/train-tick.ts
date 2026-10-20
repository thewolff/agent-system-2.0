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
//     A PR whose activity could not be read this pass has no push evidence, so neither push rule settles it.
//     Then the failed-twice alert question (`raiseTwiceFailed`, options retry / skip / stop) for each PR whose attempt 2 settled failed.
//  3. Deliveries (D7, D10 step 2). A task with no open owner gets its fix workload (`openTrainFix`: at most one per (repo, PR),
//     reused when open), except on a fork's PR (`forkOf`): no workload can push there, so the tick settles the task failed
//     and raises the retry / skip / stop alert instead (`forkTaskAlert`). An autonomous owner that is not held live is launched
//     with `launch-requested: by merge-train` once per task and again only after a runner result newer than its last launch, so
//     an owner waiting on its run is not relaunched.
//  4. Wakes (D10 step 1). A train `actionable` (a new `train:`, a settle, an unworked PR, a dependency merged on GitHub since the
//     last lane exit, Jo's answer to an alert, a passed-over PR whose retry wait has passed, a returned PR's head the train
//     has not worked, from step 1's views, or a held PR whose hold has ended, `hold-expired`, PLAN wl-mvfkv7llkp7nk0 § 3) and not
//     held live gets `launch-requested: by merge-train` and the launcher. A head's wake is recorded (`train-head-woken:`) when the
//     launcher started a lane; the head stays due under the pass-over backoff until the train works it (`trainRetries`). An ended
//     hold's wake is recorded the same way (`train-wake: pr <n> hold <entry id>`), which consumes that hold's expiry. An open
//     question never stops the tick: every pass settles, delivers and wakes on every PR.
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
//     standing workload. Then every workload closed within 14 days on a repository the test runner serves (`autoboardCandidates`,
//     newest close first; a train, a fix workload, a W a board still covers and a W whose PR ended are not read) gets `landingReady`,
//     and a ready one the live half: `gh pr view <n> --json <TASK_VIEW_FIELDS>,state,baseRefName,isDraft` (OPEN, no draft, base
//     main, head branch exactly wl/<W> on the same repository, `prStakes` normal) and, when the head is not the green sha G,
//     `gh api repos/<r>/compare/<G>...<head>` and `gh api repos/<r>/commits/<sha>` per commit: each commit touches only
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
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { loadTestRunnerConfig } from "../src/close-entry";
import { attempts, consumedIds, controlEntries, heldLive, holdersOf, LANE_SCRIPT, launchRequestedBody } from "../src/launch";
import {
	actionable, type AlertAction, autoboardCandidates, autoboardCutover, BOARD_ENDED, boardedWorkloads, boardLanding, boardSkips, checkoutOwnerRepo, everyTrain, expiredHolds, forkOf,
	forkTaskAlert, isTrainOrFix, type Landing, landingReady, MAIN_RED_WINDOW_MS, mainRedNoticeBody, mainRedNotices, mainRedRows, openTrainFix, openTrains, ownerDeliveries,
	PROTECTION_UNKNOWN_RAISE_MS, protectionEpisodes, protectionGap, protectionNoticeBody, type ProtectionNoticeState, protectionPassOvers, prStakes, raiseTwiceFailed, settleTasks,
	TASK_VIEW_FIELDS, type TaskView, taskViewOf, TRAIN_ALERT_LABEL, TRAIN_ALERT_LADDER, TRAIN_ALERT_MENTION, TRAIN_ALERT_REPO, trainActivityArgs, trainAlertActions, trainAlertBody,
	trainAlertEndBody, trainAlertMarker, trainAutoboardBody, trainBoardSkipBody, trainCheckout, trainHeadWokenBody, trainPrs, trainPushesOf, trainRetries, trainSliceId,
	trainSlicePr, type TrainPush, type TrainTask, trainWakeBody, twiceFailed, unsettledTasks,
} from "../src/merge-train";
import { bodyDeps, DEFAULT_BRANCH } from "../src/merge-train-stack";
import { sendNotice, TRAIN_SIGNOFF_APPLIED_PREFIX, trainMergedEntryBody, trainMergedNoticeBody } from "../src/notice";
import { DECISION_LOG_DIR, SHA_RE, type TestRunnerConfig, testRuns } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID } from "../src/types";

/** One gh process: its exit code and output. */
export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The tick's seams: gh, the lane launcher and the notification are injected, so a test runs a pass on fakes and a temp ledger. */
export interface TickDeps {
	ledger: Ledger;
	gh: (args: string[]) => GhResult;
	/** `lane.ts launch <wl> --requested-by merge-train`: its exit code and last line. */
	launch: (wl: string) => { code: number; line: string };
	/** A macOS notification with sound; false when it could not be shown. */
	notify: (title: string, text: string) => boolean;
	/** The test runner's served repositories (`testRunner.repos`, profile/config.yml): only their PRs board (D1); none, nothing boards. */
	config?: Pick<TestRunnerConfig, "repos">;
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
	/** Write `launch-requested: by merge-train` unless one is unconsumed already, then run the launcher; its exit code. */
	const request = (wl: string, reason: string): number => {
		const entries = ledger.entries(wl);
		const control = controlEntries(entries, holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)));
		const consumed = consumedIds(attempts(control));
		if (!control.some((c) => c.prefix === "launch-requested" && !consumed.has(c.id))) {
			ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody(MERGE_TRAIN_BY, ledger.now(), reason) });
		}
		const r = d.launch(wl);
		say(`${wl}: launch (${reason}): exit ${r.code}: ${r.line}`);
		return r.code;
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
			const settled = ledger.write(() => {
				const bodies = settleTasks(ledger, { train: wl, heads, pushes: facts.pushes }, ledger.now());
				for (const body of bodies) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body });
				return bodies;
			});
			for (const body of settled) say(`${wl}: ${body}`);
			for (const due of twiceFailed(ledger, wl)) {
				const q = raiseTwiceFailed(ledger, wl, due);
				if (q) say(`${wl}: #${due.pr} failed twice (${due.task.id}): alert question ${q}`);
			}
			// A dependency merged since the train's last lane exit wakes it (actionable's mergedDeps).
			const lastExit = controlEntries(ledger.entries(wl)).filter((c) => c.prefix === "lane-exit").at(-1)?.createdAt ?? null;
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
			const r = openTrainFix(ledger, { task: t, repo: facts.repo, checkout: facts.checkout, view, stakes: s.stakes === "production" ? "production" : "normal" });
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
	if (!ledger.workload(STANDING_WORKLOAD_ID)) say(`${STANDING_WORKLOAD_ID}: no standing workload: boarding, protection, red-main and merge notices skipped`);
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
		const held = notices.open.has(repoOf(wl) ?? "") ? protectionPassOvers(ledger, wl) : new Set<number>();
		const why = actionable(ledger, wl, facts?.mergedDeps ?? [], heads, held, stakesOf);
		const cleared = notices.wake.get(wl);
		if (cleared !== undefined) why.push(cleared);
		// A head the train has not worked: its wake is recorded only when the launcher started a lane, so a failed launch is
		// retried next pass, and a started lane that ends without working the head is retried under the backoff (`trainRetries`).
		// An ended hold's `train-wake:` (PLAN wl-mvfkv7llkp7nk0 § 3) likewise: once written it consumes the expiry, so a started
		// lane that dies before it records an outcome is not woken again for that hold.
		if (why.length > 0 && request(wl, why.join("; ")) === 0) {
			for (const h of untested) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainHeadWokenBody(h.pr, h.sha) });
			for (const h of expired) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainWakeBody(h.pr, h.holdId) });
		}
	}

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
 * Step 3b (D1, D3, D4): scan the candidates, newest close first, through `landingReady` and the live half (`liveHalf`), then board
 * the ready ones oldest close first (`boardLanding`). A candidate that cannot board gets `train-board-skip:` once per (W, pr, head,
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
	ready.sort((a, b) => a.l.closedAt.localeCompare(b.l.closedAt) || a.l.workloadId.localeCompare(b.l.workloadId));
	for (const b of ready) {
		const r = boardLanding(ledger, b.l, { head: b.head });
		if (r.boarded) say(`${r.train}: #${b.l.pr} of ${b.l.workloadId} boarded at ${b.head}${r.opened ? ", train opened" : ""} (${r.entryId})`);
		else skip(b.l.workloadId, b.l.pr, b.head, r.reason);
	}
	return ready;
}

/** GitHub's get-a-commit lists at most this many files across its pages (300 a page): a commit listing this many may have more. */
const COMMIT_FILES_CAP = 3000;

/**
 * D1's live half for ready landing `l`: `gh pr view <n> --json <TASK_VIEW_FIELDS>,state,baseRefName,isDraft` shows it OPEN, no
 * draft, based on main, its head branch exactly `wl/<W>` with `prStakes` normal (same repository, no fork); and its head is the
 * green sha G, or ahead of G (`gh api repos/<r>/compare/<G>...<head>`) only by commits each touching only .ai/decision-log/
 * (`gh api repos/<r>/commits/<sha> --paginate --slurp`, each commit's own files over every page, never the net diff; a rename's
 * `previous_filename` too, review wl-mvbjiettjrfpxc r1 #2). A commit listing COMMIT_FILES_CAP files may have more GitHub does not
 * list, so it never boards. A failed or unreadable gh call throws.
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
	const cmp = ghJson(["api", `repos/${l.repo}/compare/${l.sha}...${head}`]);
	const [status, commits, total] = [field(cmp, "status"), field(cmp, "commits"), field(cmp, "total_commits")];
	if (typeof status !== "string" || !Array.isArray(commits) || typeof total !== "number") throw new GhError(`gh api repos/${l.repo}/compare returned an unexpected shape`);
	if (status !== "ahead") return no(`head ${head} is not ahead of the green sha ${l.sha} (compare: ${status})`);
	if (commits.length !== total) return no(`head ${head} is ${total} commits ahead of ${l.sha}, more than the compare lists (${commits.length})`);
	for (const c of commits as unknown[]) {
		const sha = field(c, "sha");
		if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new GhError(`gh api repos/${l.repo}/compare listed a commit with no sha`);
		// Every page of the commit's files: an array of pages, each the commit object with its share of `files`.
		const pages = ghJson(["api", `repos/${l.repo}/commits/${sha}`, "--paginate", "--slurp"]);
		const files = Array.isArray(pages) && pages.length > 0 ? (pages as unknown[]).map((p) => field(p, "files")) : null;
		if (files === null || !files.every(Array.isArray)) throw new GhError(`gh api repos/${l.repo}/commits/${sha} returned an unexpected shape`);
		const entries = (files as unknown[][]).flat();
		if (entries.length >= COMMIT_FILES_CAP) return no(`commit ${sha} after the green sha lists ${entries.length} files, the most GitHub lists; its other files cannot be read`);
		for (const f of entries) {
			// A rename touches the path it left as well as the one it made; a rename that names no previous path fails closed.
			const prev = field(f, "previous_filename");
			const paths = [field(f, "filename"), ...(prev !== undefined || field(f, "status") === "renamed" ? [prev] : [])];
			const i = paths.findIndex((p) => typeof p !== "string" || !p.startsWith(DECISION_LOG_DIR));
			if (i >= 0) return no(`commit ${sha} after the green sha touches ${String(paths[i])}, not only ${DECISION_LOG_DIR}`);
		}
	}
	return { ok: true, head };
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

/** gh on PATH, 60 s at most. */
function realGh(args: string[]): GhResult {
	const r = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.exitedDueToTimeout ? "timed out" : r.stderr.toString() };
}

/** The lane starter, awaited (it spawns the runner detached and returns). */
function realLaunch(wl: string): { code: number; line: string } {
	const r = Bun.spawnSync([process.execPath, LANE_SCRIPT, "launch", wl, "--requested-by", MERGE_TRAIN_BY], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	const lines = (r.stdout.toString().trim() || r.stderr.toString().trim()).split("\n").filter(Boolean);
	return { code: r.exitCode ?? 1, line: lines.at(-1) ?? (r.exitedDueToTimeout ? "timed out" : "no output") };
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
		tick({ ledger, gh: realGh, launch: realLaunch, notify: realNotify, log, ...(cfg.ok ? { config: cfg.config } : {}) });
		return 0;
	} finally {
		ledger.close();
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
