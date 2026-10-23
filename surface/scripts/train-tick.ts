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
//     last lane exit, Jo's answer to an alert, a passed-over PR whose retry wait has passed, or a returned PR's head the train
//     has not worked, from step 1's views) and not held live gets `launch-requested: by merge-train` and the launcher. A head's wake is
//     recorded (`train-head-woken:`) when the launcher started a lane; the head stays due under the pass-over backoff until the
//     train works it (`trainRetries`). An open question never stops the tick: every pass settles, delivers and wakes on every PR.
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
//
// A gh failure is logged on the train as `train-error: tick <reason>` (written again only when the reason changes) and retried
// next run; Jo is not alerted. The launcher is `bun surface/scripts/lane.ts launch <wl> --requested-by merge-train`.
// Exit: 0 the pass ran (logged errors included), 1 the ledger could not be opened, 2 an argument was given.
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { attempts, controlEntries, heldLive, holdersOf, LANE_SCRIPT, launchRequestedBody, pendingRequests } from "../src/launch";
import {
	actionable, type AlertAction, checkoutOwnerRepo, forkOf, forkTaskAlert, openTrainFix, openTrains, ownerDeliveries, prStakes, raiseTwiceFailed, settleTasks, TASK_VIEW_FIELDS,
	type TaskView, taskViewOf, TRAIN_ALERT_LABEL, TRAIN_ALERT_LADDER, TRAIN_ALERT_MENTION, TRAIN_ALERT_REPO, trainActivityArgs, trainAlertActions, trainAlertBody,
	trainAlertEndBody, trainAlertMarker, trainCheckout, trainHeadWokenBody, trainPrs, trainPushesOf, trainRetries, trainSliceId, type TrainPush, type TrainTask, twiceFailed,
	unsettledTasks,
} from "../src/merge-train";
import { bodyDeps } from "../src/merge-train-stack";
import { testRuns } from "../src/test-run";
import { MERGE_TRAIN_BY } from "../src/types";

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
	/** Write `launch-requested: by merge-train` unless one is pending already (`pendingRequests`), then run the launcher; its exit code. */
	const request = (wl: string, reason: string): number => {
		const entries = ledger.entries(wl);
		if (pendingRequests(controlEntries(entries, holdersOf(entries, ledger.workload(wl)?.holder ?? null, ledger.holders(wl)))).length === 0) {
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
			const r = openTrainFix(ledger, { task: t, repo: facts.repo, checkout: facts.checkout, view, stakes: prStakes(view, facts.repo, ledger).stakes });
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

	// 4. Wakes.
	for (const wl of openTrains(ledger)) {
		const w = ledger.workload(wl);
		if (!w || heldLive(w, ledger.now())) continue;
		const facts = factsOf(wl);
		const heads = new Map([...(facts?.views ?? [])].map(([n, v]) => [n, v.headRefOid]));
		const untested = trainRetries(ledger, wl, heads).untested;
		const why = actionable(ledger, wl, facts?.mergedDeps ?? [], heads);
		// A head the train has not worked: its wake is recorded only when the launcher started a lane, so a failed launch is
		// retried next pass, and a started lane that ends without working the head is retried under the backoff (`trainRetries`).
		if (why.length > 0 && request(wl, why.join("; ")) === 0) {
			for (const h of untested) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainHeadWokenBody(h.pr, h.sha) });
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
 * Whether owner `owner` is launched for task `t` now: a `launch-requested:` is pending (`pendingRequests`: the fix workload's
 * own, or one a failed launch left); or no lane was launched on it since the task; or a runner result on the PR came after
 * its last launch (the run the lane waited for has answered).
 */
function ownerLaunchDue(ledger: Ledger, owner: string, t: TrainTask): boolean {
	const entries = ledger.entries(owner);
	const control = controlEntries(entries, holdersOf(entries, ledger.workload(owner)?.holder ?? null, ledger.holders(owner)));
	if (pendingRequests(control).length > 0) return true;
	const last = attempts(control).at(-1)?.createdAt;
	if (last === undefined || last < t.createdAt) return true;
	return testRuns(entries).some((r) => r.request.pr === t.pr && r.result !== null && r.result.createdAt > last);
}

/** The issue number of a jo-issues url. */
function issueNumber(url: string): string {
	const m = /\/issues\/(\d+)$/.exec(url);
	if (!m) throw new GhError(`${url} is not an issue url`);
	return m[1]!;
}

/** One alert action's effects (D9's send ladder, or the close after Jo's answer). */
function alert(d: TickDeps, facts: TrainFacts, a: AlertAction, ghJson: (args: string[]) => unknown, say: (line: string) => void): void {
	const { ledger } = d;
	const { q, pr, reason, options, record } = a.alert;
	const write = (body: string) => ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: facts.wl, kind: "assumption", body });
	const failed = (args: string[], r: GhResult) =>
		new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? ""}`);
	const run = (args: string[]): string => {
		const r = d.gh(args);
		if (r.code !== 0) throw failed(args, r);
		return r.stdout;
	};
	/**
	 * The url of the issue the train filed whose body carries `marker`, any state; null only when the whole listing has none. A
	 * failed or unreadable listing throws: the caller writes nothing durable and the next pass looks again.
	 */
	const marked = (marker: string): string | null => {
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
	};
	/**
	 * A gh call that adds labels; its stdout. A failure is retried once, and only when gh says one of `labels` is missing
	 * (`'<label>' not found`), after each label is created (one that exists already fails harmlessly). `took`, when given, is
	 * asked after every failure whether the call took effect anyway (an issue create whose reply was lost): its answer is
	 * returned and nothing is retried.
	 */
	const labelled = (args: string[], labels: readonly string[], took?: () => string | null): string => {
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
	};
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
		const stamp = () => new Date().toISOString();
		tick({ ledger, gh: realGh, launch: realLaunch, notify: realNotify, log: (l) => process.stdout.write(`${stamp()} ${l}\n`) });
		return 0;
	} finally {
		ledger.close();
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
