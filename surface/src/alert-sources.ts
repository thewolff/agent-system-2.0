// The alert sources (PLAN wl-mw0vs9uc3xqtka D2): every thing Jo must hear about right now, computed fresh from the ledger
// and the files each pass (level-triggered: a subject is active while its condition holds and gone once it clears, so no
// event is lost and a replay reproduces it). Each source is pure over the ledger plus the injected seams: the clock
// (`now`), the urgency predicate (`urgent`, alert-path.ts `urgencyOf` in the pass), the alarm file and the chaos reports
// dir (files), the runner probe (pids, surface/src/runner-probe.ts), the train's GitHub repository and the popup answer
// of the alert path. Each returns `AlertSubject[]`; a per-item failure it can name (ps could not answer for one lane, a
// report heading that does not parse) goes to `problems` and the other items still count. `alertSources` runs every
// source, and a source that throws is one problem naming it, so one failure never hides another source's subjects.
//
//  1. ceiling `ceiling:<wl>`: an open, non-train workload stopped at its ceiling (`ceilingStopped`) whose newest lane
//     lifecycle entry is `lane-stop: <lane> accepted ceiling` or `lane-exit: … outcome stop reason ceiling`, with no live
//     holder and no `halt <wl>` or `stop` answer to the runner's ceiling question since that entry; or an uncleared
//     `CEILING ALARM` line of the alarm file (`ceilingAlarms`, cleared by Jo's ceiling, extend or halt word) on a workload
//     no lane holds live, with no `stop` answer to the runner's ceiling question since the alarm (R2's whole clear set).
//  2. died `died:<wl>`: an open workload with open or paused slices whose newest lane ended by a `lane-died:` message or an
//     unrecorded lapse (`laneDeaths`, `unrecordedLapse`), not routed into a train task (`trainRouted`), no live holder.
//  3. released-alive `lane:<laneId>`: a `lane-released: <laneId>` entry 5 minutes old or more, no `lane-exit:` for the lane,
//     and its omp or runner pid alive per the runner probe (`liveRunnerOf`).
//  4. main-red `main:<owner/repo>`: an open land-first stop episode of kind regression or infrastructure (`stopEpisode`), or
//     an uncleared main-red notice (`mainRedNotices`).
//  5. chaos `chaos:<report file>`: the newest nightly chaos report (`<PT date>-<nightlyFault(date)>.md`) when its heading's
//     verdict is FAIL or HARNESS-ERROR.
//  6. parked `parked:<wl>`: any open workload with a waiting reserved request or an open prompt wait, and for a non-train
//     workload an open question.
//  7. train `q:<id>`: every open question on a merge train.
//  8. quota-move `move:<E>`: every recorded quota move (`quotaMoves`) until 24 h after its popup was answered; start level 2.
// The quota alerts (`quota:<key>:<rule>`, D7) are surface/src/quota-watch.ts's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InFlightWorkload, Ledger } from "../../ledger/src/index";
import type { AlertKind, AlertSubject } from "./alert-path";
import { ceilingNoticeBody, ceilingStopped } from "./ceiling";
import { nightlyFault } from "./chaos";
import { ceilingAlarms, controlOf, plain, reservedStates, trainRouted, wordsOf } from "./errors";
import { HALT_WORD, isRunnerCeilingQuestion } from "./input";
import { type ControlEntry, controlEntries, heldLive, holdersOf, laneExit } from "./launch";
import {
	isTrain, landFirstRows, latestTrainReconciled, mainRedNotices, stopEpisode, stopSummary, trainAlertReason, trainSlicePr, trainTaskWindows,
} from "./merge-train";
import { alertRows, moveText, moveTitle, quotaMoves } from "./quota-move-alert";
import { liveRunnerOf, type RunnerProbe, runnerProbe } from "./runner-probe";
import { laneDeaths, openPromptWaits, unrecordedLapse } from "./signals";
import { STANDING_WORKLOAD_ID } from "./types";

/** A released lane is an alert only once its `lane-released:` entry is this old (D2.3): a lane's own exit takes a moment. */
export const RELEASED_ALIVE_AFTER_MS = 5 * 60_000;
/** A quota move stays a subject until this long after its popup was answered (D2.8: a move is an event, not a state). */
export const MOVE_ANSWERED_KEEP_MS = 24 * 3_600_000;

/** The chaos reports' file reader (D2.5); the tests may pass a fake. `list` is null when the dir does not exist. */
export interface ReportFiles {
	list(dir: string): string[] | null;
	read(path: string): string;
}

/** The machine's reports dir, read through node:fs; a listing or read error throws (the source's problem). */
export const fsReportFiles: ReportFiles = {
	list: (dir) => (existsSync(dir) ? readdirSync(dir) : null),
	read: (path) => readFileSync(path, "utf8"),
};

/** What the sources read beside the ledger. */
export interface SourceSeams {
	/** The pass's clock, ISO-8601 UTC. */
	now: string;
	/** Whether a workload is urgent (D5): its subjects start at level 2. */
	urgent: (wl: string) => boolean;
	/** The alarm file `alarmLines` reads (its `CEILING ALARM` lines, D2.1). */
	alarmFile: string;
	/** The chaos reports dir (surface/scripts/chaos.ts REPORTS_DIR, or AS2_CHAOS_REPORTS). */
	reportsDir: string;
	files: ReportFiles;
	/** The runner probe for one lane id of a workload (`runnerProbe`); `failure` names why a `failed` answer failed. */
	probe: (wl: string, laneId: string) => RunnerProbe & { failure: string | null };
	/** A merge train's GitHub `owner/repo`, for its PR urls; null when it cannot be read (the text says so). */
	trainRepo: (wl: string) => string | null;
	/** When the alert path's popup for `key` was answered (`alert-popup: <key> … ok <button>`, any level), else null. */
	popupAnsweredAt: (key: string) => string | null;
}

/** The machine's probe (ps through surface/src/runner-probe.ts). */
export const psProbe: SourceSeams["probe"] = (wl, laneId) => runnerProbe(wl, laneId);

/**
 * A per-item failure a source could name: what broke, where, and the evidence; the pass shows it, the next pass retries.
 * What it holds (review r1 #4): with no `key`, every open episode of the source's kind, whose state is unknown while it
 * stands; with a `key`, that key only; with `key: null`, nothing (a bad item that names no key and cannot clear one).
 */
export interface SourceProblem {
	source: AlertKind;
	error: string;
	key?: string | null;
}

/** The workloads open now, with their status rows (`Ledger.inFlight`), read once per pass. */
type Open = readonly InFlightWorkload[];

const levelOf = (s: SourceSeams, wl: string | null): 1 | 2 => (wl !== null && s.urgent(wl) ? 2 : 1);
const errText = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

// ---- 1. ceiling --------------------------------------------------------------------------------------------------

/** The lane lifecycle prefixes: what a lane did last, never what it spent or recorded about itself. */
const LIFECYCLE: Partial<Record<ControlEntry["prefix"], true>> = {
	launch: true, "launch-failed": true, "lane-started": true, "lane-ready": true, "lane-parked": true, "lane-stop": true, "lane-decided": true, "lane-exit": true,
};

/** The newest lane lifecycle entry when it is a ceiling stop (`lane-stop: … accepted ceiling`, `lane-exit: … outcome stop reason ceiling`); else null. */
export function ceilingStopEntry(control: readonly ControlEntry[]): ControlEntry | null {
	for (let i = control.length - 1; i >= 0; i--) {
		const c = control[i]!;
		if (c.laneId === null || !LIFECYCLE[c.prefix]) continue;
		if (c.prefix === "lane-stop") return /^accepted ceiling\b/.test(c.rest) ? c : null;
		if (c.prefix === "lane-exit") {
			const exit = laneExit([c], c.laneId);
			return exit?.outcome === "stop" && exit.reason === "ceiling" ? c : null;
		}
		return null;
	}
	return null;
}

/** Jo's word since `at` that ends a ceiling stop with no raise: `halt <wl>`, or `stop` answering the runner's ceiling question. */
function stopEnded(ledger: Ledger, wl: string, at: string): boolean {
	const questions = ledger.questions(wl);
	return ledger.instructions(wl).some((i) => {
		if (i.author !== "jo" || i.created_at <= at) return false;
		if (i.body.trim() === `${HALT_WORD} ${wl}`) return true;
		const q = i.kind === "answer" && i.question_id !== null ? questions.find((x) => x.id === i.question_id) : undefined;
		return q !== undefined && i.body.trim() === "stop" && isRunnerCeilingQuestion(q);
	});
}

/** The alarm file's text as lines, [] when there is none; a file that cannot be read throws naming it (the ceiling source fails, D2). */
function alarmFileLines(path: string): string[] {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8").split("\n");
	} catch (err) {
		throw new Error(`the alarm file ${path} cannot be read, so its CEILING ALARM lines are unknown: ${errText(err)}`);
	}
}

/** D2.1: each open, non-train workload stopped at its ceiling with no lane on it and no stop from Jo; or with an uncleared CEILING ALARM line, under the same clear set. */
export function ceilingSubjects(ledger: Ledger, open: Open, s: SourceSeams): AlertSubject[] {
	const out: AlertSubject[] = [];
	const alarms = ceilingAlarms(ledger, alarmFileLines(s.alarmFile));
	for (const { workload: w } of open) {
		if (w.id === STANDING_WORKLOAD_ID || isTrain(ledger, w.id)) continue;
		const facts: string[] = [];
		const control = controlOf(ledger, w.id, w.holder);
		const stopped = ceilingStopped(control, ledger.instructions(w.id), w.stakes);
		const stop = stopped === null ? null : ceilingStopEntry(control);
		if (stopped !== null && stop !== null && !heldLive(w, s.now) && !stopEnded(ledger, w.id, stop.createdAt)) {
			facts.push(ceilingNoticeBody(100, w.id, stopped.spend, stopped.ceiling, w.stakes), `${stop.laneId} stopped: ${stop.body} (${stop.id}, ${stop.createdAt}); no lane holds it.`);
		}
		for (const a of alarms) {
			if (a.line.workloadId !== w.id || heldLive(w, s.now) || (a.at !== null && stopEnded(ledger, w.id, a.at))) continue;
			facts.push(`${a.line.line} (alarm file ${s.alarmFile}, ${a.line.rowId})`);
		}
		if (facts.length === 0) continue;
		const usd = stopped === null ? "" : ` ($${stopped.spend.usd.toFixed(2)} of $${stopped.ceiling.usd})`;
		out.push({
			key: `ceiling:${w.id}`, kind: "ceiling", workloadId: w.id, startLevel: levelOf(s, w.id),
			title: `${w.id} stopped at its ceiling${usd}`,
			text: [`${w.id}: ${wordsOf(ledger, w.id, control)}`, ...facts].join("\n"),
			next: `extend ${w.id}, or ceiling <usd> [<hours>] ${w.id}`,
		});
	}
	return out;
}

// ---- 2. died -----------------------------------------------------------------------------------------------------

/** D2.2: each open workload with open or paused slices whose newest lane died (a `lane-died:` or an unrecorded lapse), no live holder, not a train task's. */
export function diedSubjects(ledger: Ledger, open: Open, s: SourceSeams): AlertSubject[] {
	const out: AlertSubject[] = [];
	const windows = trainTaskWindows(ledger);
	for (const { workload: w } of open) {
		const left = w.open_slices + w.paused_slices;
		if (left === 0) continue;
		const wins = windows.get(w.id) ?? [];
		const deaths = laneDeaths(ledger, w.id);
		const times = deaths.map((d) => d.created_at);
		let death: { lane: string; why: string; at: string; ref: string } | null = null;
		if (unrecordedLapse(ledger, w, s.now)) {
			if (trainRouted(wins, w.holder_lease_until!, times) === null) death = { lane: w.holder!, why: `lease lapsed ${w.holder_lease_until}`, at: w.holder_lease_until!, ref: "no lane-died: row yet" };
		} else if (!heldLive(w, s.now)) {
			const d = deaths.at(-1);
			const control = d ? controlOf(ledger, w.id, w.holder) : [];
			// A lane launched or started after the death is the newest lane: its own end is what counts, not this death.
			const later = d ? control.some((c) => (c.prefix === "launch" || c.prefix === "lane-started") && c.createdAt > d.created_at) : true;
			if (d && !later && trainRouted(wins, d.created_at, times) === null) {
				death = { lane: d.holder, why: d.body.slice(`lane-died: ${d.holder}:`.length).trim(), at: d.created_at, ref: d.id };
			}
		}
		if (death === null) continue;
		out.push({
			key: `died:${w.id}`, kind: "died", workloadId: w.id, startLevel: levelOf(s, w.id),
			title: `lane ${death.lane} died on ${w.id} with ${left} slice(s) open or paused`,
			text: [
				`${w.id}: ${wordsOf(ledger, w.id)}`,
				`lane ${death.lane} died: ${death.why} (${death.ref}, ${death.at}).`,
				`${w.open_slices} open and ${w.paused_slices} paused slice(s); no lane holds it.`,
			].join("\n"),
			// What Jo does about a workload whose lane is gone (errors.ts's words): a user-driven one has no relaunch.
			next: w.mode === "user-driven" ? `continue it by hand (as2 lane ${w.id}), close it, or instruct` : `relaunch ${w.id}, close it, or instruct`,
		});
	}
	return out;
}

// ---- 3. released-alive -------------------------------------------------------------------------------------------

/**
 * D2.3: each `lane-released:` (the releasing lane's own, `controlEntries`) at least RELEASED_ALIVE_AFTER_MS old whose lane has
 * no `lane-exit:` and whose omp or runner pid the probe finds alive. A probe ps could not answer is a problem, not a subject.
 * Every workload is read, open or closed: a lane can outlive its workload's close.
 */
export function releasedAliveSubjects(ledger: Ledger, s: SourceSeams, problems: SourceProblem[]): AlertSubject[] {
	const out: AlertSubject[] = [];
	const cutoff = new Date(Date.parse(s.now) - RELEASED_ALIVE_AFTER_MS).toISOString();
	const workloads = ledger.db.query<{ workload_id: string }, [string]>(
		"SELECT DISTINCT workload_id FROM entries WHERE kind = 'assumption' AND instr(body, ?1) = 1 ORDER BY workload_id",
	).all("lane-released: ").map((r) => r.workload_id);
	for (const wl of workloads) {
		const w = ledger.workload(wl);
		if (!w) continue;
		const entries = ledger.entries(wl);
		const control = controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(wl)));
		const seen = new Set<string>();
		for (const c of control) {
			if (c.prefix !== "lane-released" || c.laneId === null || seen.has(c.laneId)) continue;
			seen.add(c.laneId);
			const lane = c.laneId;
			const newest = control.findLast((x) => x.prefix === "lane-released" && x.laneId === lane)!;
			if (newest.createdAt > cutoff || laneExit(control, lane) !== null) continue;
			const probe = s.probe(wl, lane);
			const live = liveRunnerOf(control, lane, 0, probe);
			if (live === null) continue;
			if (live.uninspected) {
				problems.push({ source: "released-alive", key: `lane:${lane}`, error: `${lane} on ${wl}: ps could not answer for its ${live.what} pid ${live.pid} (${probe.failure ?? "no reason recorded"}); released ${newest.createdAt}, no lane-exit:` });
				continue;
			}
			out.push({
				key: `lane:${lane}`, kind: "released-alive", workloadId: wl, startLevel: levelOf(s, wl),
				title: `${lane} released ${wl} but its ${live.what} is still running`,
				text: [
					`${lane} released ${wl} at ${newest.createdAt} (${newest.id}) and wrote no lane-exit: since.`,
					`Its ${live.what} pid ${live.pid} is alive${live.unverified ? " (no start time was recorded to tell it from another process with that pid)" : ""}: it may still be spending or holding a worktree.`,
				].join("\n"),
				next: `end it: kill ${live.pid} after checking it is ${lane}'s ${live.what}, or bun surface/scripts/lane.ts stop ${wl}`,
			});
		}
	}
	return out;
}

// ---- 4. main-red -------------------------------------------------------------------------------------------------

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/;

/** D2.4: each repository with an open regression or infrastructure stop episode, or an uncleared main-red notice. */
export function mainRedSubjects(ledger: Ledger, s: SourceSeams, problems: SourceProblem[]): AlertSubject[] {
	const entries = ledger.entries(STANDING_WORKLOAD_ID);
	const byRepo = new Map<string, { stop: string | null; next: string | null; notices: string[] }>();
	const at = (repo: string) => {
		const r = byRepo.get(repo) ?? { stop: null, next: null, notices: [] };
		byRepo.set(repo, r);
		return r;
	};
	const rows = landFirstRows(entries);
	for (const repo of [...new Set(rows.map((r) => r.repo))].sort()) {
		const ep = stopEpisode(rows.filter((r) => r.repo === repo));
		if (ep === null || ep.state.kind === "depth") continue;
		const reasons = latestTrainReconciled(entries, repo)?.r.reasons.split("; ").filter((x) => x !== "") ?? [];
		const why = reasons.length > 0 ? reasons : [`no train-reconciled: reasons recorded for ${repo}`];
		const r = at(repo);
		r.stop = `${stopSummary(repo, { kind: ep.state.kind, tip: ep.state.tip, g: ep.state.g, suspects: ep.state.suspects, reasons: why })} (stop ${ep.raised.entryId}, newest state ${ep.state.entryId})`;
		r.next = ep.state.kind === "regression" ? "name a fix PR in this issue, or let the merge train revert the suspects" : `fix the runner, then say main-retry ${repo}`;
	}
	for (const n of mainRedNotices(ledger).values()) {
		if (n.cleared !== null) continue;
		const m = ISSUE_URL.exec(n.url);
		if (!m) {
			problems.push({ source: "main-red", key: null, error: `main-red notice ${n.raised.id}: ${n.url} is not a GitHub issue url, so no repository key; not raised` });
			continue;
		}
		at(m[1]!.toLowerCase()).notices.push(`Main is red on ${m[1]}: ${n.url} (merge train run ${n.run}, raised ${n.raised.createdAt}).`);
	}
	return [...byRepo].map(([repo, r]): AlertSubject => ({
		key: `main:${repo}`, kind: "main-red", workloadId: null, startLevel: 1,
		title: r.stop !== null ? `landing stopped on ${repo}` : `main is red on ${repo}`,
		text: [...(r.stop === null ? [] : [r.stop]), ...r.notices].join("\n"),
		next: r.next ?? `fix main on ${repo}; this closes when the main-red issue closes`,
	}));
}

// ---- 5. chaos ----------------------------------------------------------------------------------------------------

const NIGHTLY_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/;
const HEADING = /^# chaos (\S+)(?: \([^)]*\))?: (PASS|FAIL|HARNESS-ERROR)\s*$/;

/** D2.5: the newest nightly report (`<PT date>-<that date's nightlyFault>.md`, the name `--nightly` writes first) when it is not PASS. */
export function chaosSubjects(s: SourceSeams, problems: SourceProblem[]): AlertSubject[] {
	const names = s.files.list(s.reportsDir);
	if (names === null) return [];
	const nightly = names.filter((f) => {
		const m = NIGHTLY_NAME.exec(f);
		return m !== null && nightlyFault(m[1]!) === m[2];
	}).sort();
	const newest = nightly.at(-1);
	if (newest === undefined) return [];
	const path = join(s.reportsDir, newest);
	const lines = s.files.read(path).split("\n");
	const head = HEADING.exec(lines[0] ?? "");
	if (!head) {
		problems.push({ source: "chaos", error: `${path}: the first line is not "# chaos <fault>: <verdict>" (read: ${JSON.stringify((lines[0] ?? "").slice(0, 120))}); its verdict is unknown` });
		return [];
	}
	if (head[2] === "PASS") return [];
	const why = lines.find((l) => l.startsWith("- verdict: "));
	return [{
		key: `chaos:${newest}`, kind: "chaos", workloadId: null, startLevel: 1,
		title: `nightly chaos ${head[1]}: ${head[2]}`,
		text: [`The nightly chaos run ${newest} ended ${head[2]}.`, ...(why ? [plain(why.slice(2))] : []), `Report: ${path}`].join("\n"),
		next: `read ${path} and fix what it names; the next nightly PASS closes this, or ack chaos:${newest}`,
	}];
}

// ---- 6. parked, 7. train -----------------------------------------------------------------------------------------

/** D2.6: each open workload blocked on Jo: waiting reserved requests, open prompt waits, and (not on a train) open questions. */
export function parkedSubjects(ledger: Ledger, open: Open, s: SourceSeams): AlertSubject[] {
	const out: AlertSubject[] = [];
	for (const { workload: w, openQuestions } of open) {
		const lines: string[] = [];
		const answers: string[] = [];
		for (const r of reservedStates(ledger, w.id)) {
			if (r.state.kind !== "waiting") continue;
			lines.push(`reserved action ${r.id} waiting since ${r.created_at}: ${plain(r.body)}`);
			answers.push(`approve ${r.id} or deny ${r.id}`);
		}
		for (const p of openPromptWaits(ledger, w.id)) {
			lines.push(`lane ${p.lane} is blocked on a human prompt (${p.toolName}, tool call ${p.toolCallId}, since ${p.created_at}): ${plain(p.reason)}`);
			answers.push(`answer ${p.lane}'s prompt in its session or end the session`);
		}
		if (openQuestions.length > 0 && !isTrain(ledger, w.id)) {
			for (const q of openQuestions) {
				lines.push(`question ${q.id} (slice ${q.slice_id}, since ${q.created_at}): ${plain(q.body)}`);
				answers.push(`answer ${q.id}: ${q.options.join(" / ")}`);
			}
		}
		if (lines.length === 0) continue;
		out.push({
			key: `parked:${w.id}`, kind: "parked", workloadId: w.id, startLevel: levelOf(s, w.id),
			title: `${w.id} is waiting on you (${lines.length} item${lines.length === 1 ? "" : "s"})`,
			text: [`${w.id}: ${wordsOf(ledger, w.id)}`, ...lines].join("\n"),
			next: answers.join("; "),
		});
	}
	return out;
}

/** D2.7: every open question on a merge train, one key each; a PR question's text is today's train issue's. */
export function trainSubjects(ledger: Ledger, open: Open, s: SourceSeams): AlertSubject[] {
	const out: AlertSubject[] = [];
	for (const { workload: w, openQuestions } of open) {
		if (openQuestions.length === 0 || !isTrain(ledger, w.id)) continue;
		const repo = s.trainRepo(w.id);
		for (const q of openQuestions) {
			const pr = trainSlicePr(q.slice_id, w.id);
			const reason = trainAlertReason(q.options);
			const answer = `answer ${q.id} with one word: ${q.options.join(" / ")}`;
			const head = pr === null
				? `Merge train ${w.id} asks you (question ${q.id}, slice ${q.slice_id}).`
				: `Merge train ${w.id} on ${repo ?? "a repository it could not read"}: ${repo === null ? `PR #${pr}` : `https://github.com/${repo}/pull/${pr}`} needs you (${reason}).`;
			out.push({
				key: `q:${q.id}`, kind: "train", workloadId: w.id, startLevel: levelOf(s, w.id),
				title: pr === null ? `merge train ${w.id}: question ${q.id} needs you (${reason})` : `merge train: #${pr} needs you (${reason})`,
				text: [head, "", `Question ${q.id}; ${answer} in the as2 session.`, "", q.body].join("\n"),
				next: answer,
			});
		}
	}
	return out;
}

// ---- 8. quota-move -----------------------------------------------------------------------------------------------

/** D2.8: every recorded quota move, start level 2, until MOVE_ANSWERED_KEEP_MS after its popup was answered (the alert path's or the legacy one's). */
export function quotaMoveSubjects(ledger: Ledger, s: SourceSeams): AlertSubject[] {
	const out: AlertSubject[] = [];
	for (const move of quotaMoves(ledger)) {
		const key = `move:${move.eventId}`;
		const legacy = alertRows(ledger, move).filter((r) => r.channel === "popup" && r.status === "ok").map((r) => r.at);
		const answered = [s.popupAnsweredAt(key), ...legacy].filter((t): t is string => t !== null).sort().at(-1);
		if (answered !== undefined && Date.parse(s.now) - Date.parse(answered) >= MOVE_ANSWERED_KEEP_MS) continue;
		out.push({
			key, kind: "quota-move", workloadId: move.workloadId, startLevel: 2,
			title: moveTitle(move),
			text: [moveText(move), `Moved at ${move.at} (event ${move.eventId}); nothing to answer.`].join("\n"),
			next: `nothing to answer; ack ${key} once seen`,
		});
	}
	return out;
}

// ---- all ---------------------------------------------------------------------------------------------------------

/** Every source over one read of the open workloads; a source that throws is one problem naming it, and the rest still count. */
export function alertSources(ledger: Ledger, s: SourceSeams): { subjects: AlertSubject[]; problems: SourceProblem[] } {
	const problems: SourceProblem[] = [];
	const subjects: AlertSubject[] = [];
	let open: Open = [];
	try {
		open = ledger.inFlight();
	} catch (err) {
		for (const source of ["ceiling", "died", "parked", "train"] as const) problems.push({ source, error: `ledger.inFlight() failed, so the ${source} source was not computed: ${errText(err)}` });
	}
	const run = (source: AlertKind, f: () => AlertSubject[]) => {
		try {
			subjects.push(...f());
		} catch (err) {
			problems.push({ source, error: `the ${source} source failed: ${errText(err)}` });
		}
	};
	run("ceiling", () => ceilingSubjects(ledger, open, s));
	run("died", () => diedSubjects(ledger, open, s));
	run("released-alive", () => releasedAliveSubjects(ledger, s, problems));
	run("main-red", () => mainRedSubjects(ledger, s, problems));
	run("chaos", () => chaosSubjects(s, problems));
	run("parked", () => parkedSubjects(ledger, open, s));
	run("train", () => trainSubjects(ledger, open, s));
	run("quota-move", () => quotaMoveSubjects(ledger, s));
	return { subjects, problems };
}
