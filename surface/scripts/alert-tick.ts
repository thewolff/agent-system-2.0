// The alert pass (PLAN wl-mw0vs9uc3xqtka D3, D7; R1, R8-R24): the one owner of every Jo-directed alert outside an LLM.
//
// `bun surface/scripts/alert-tick.ts [--kicked-by <why>]` runs one pass; three callers start it:
// - the merge train's tick (surface/scripts/train-tick.ts), in process, at the end of every tick (every 5 minutes);
// - the runner (surface/scripts/lane.ts), detached, after a quota move it recorded and after a ceiling stop it accepted;
// - the classifier (classifier/extension.ts), detached, after a hand's quota move (both through surface/src/notify.ts
//   `kickAlerts`).
// Two passes never overlap: a pass holds `~/.agent-system-2/alert-pass.lock` (surface/src/runner-probe.ts `takeRunnerLock`,
// the runner lock's pid-and-start-time owner check); a pass that finds it held exits 0 with one log line, and the next tick
// or kick does the work. The pass starts no lane, test run, promotion or doctor step.
//
// One pass, in order (D7's call order):
//  1. The quota watch (surface/src/quota-watch.ts `runQuotaWatch`): its quota subjects, its log, its error.
//  2. The sources (surface/src/alert-sources.ts `alertSources`): every subject active now. Urgency from `urgencyOf`, a popup's
//     answer from the `alert-popup:` rows, a train's repository from the tick's own read.
//  3. Legacy adoption (D3): every in-flight alert of the retired paths (`train-alert:` rows, `quota-move-alert:` rows, a
//     land-first stop's or a main-red notice's filed issue) becomes its key's episode, one write per key, closed against its
//     old markers; several legacy issues on one key keep one canonical issue and close the others with a pointer; a legacy
//     quota-move popup still on screen is settled first. A key whose lookups fail is held back this pass.
//  4. `alertActions` (surface/src/alert-path.ts), over the subjects, the `alert:` rows, each open episode's issue state as
//     read now, and Jo's `ack` words; then the effects: the jo-issues issue, comments, labels (through jo-issues.ts
//     `issueOps`, without its retrying `labelled`), each effect looked up by its marker first. A gh failure is the key's
//     `alert: <key> error gh …` row (written when the text changes) and stops that key for this pass; nothing retries
//     inside a pass.
//  5. The popups (D3 popup worker): every unsettled attempt settled by its members' pid and lstart pairs and their
//     AS2_ALERT_POPUP tag (surface/scripts/alert-popup.ts), then a worker spawned, detached, for each sent level with a
//     popup that has none, while attempts remain. One spawn per level per pass.
// Seams (main): AGENT_SYSTEM_LEDGER_DB (the ledger), AS2_ALERT_GH (the gh binary), AS2_ALERT_SPAWN_LOG (the popup worker's
// log), QUIET_ALARM_OSASCRIPT / _AFPLAY / _SAY (inherited by the popup), AS2_CHAOS_REPORTS, AS2_QUOTA_DIR.
import { homedir } from "node:os";
import { join } from "node:path";
import { type InstructionRow, Ledger } from "../../ledger/src/index";
import { defaultLedgerPath, homeDir } from "../../ledger/src/locality";
import { alarmFilePath } from "../../gates/src/routine-switch";
import {
	ALERT_LADDER, ALERT_POPUP_ATTEMPTS, type AlertAck, type AlertAction, alertAcks, alertActions, type AlertKeyRecord, alertMarker, alertPopupAnsweredAt,
	alertPopupRows, alertRecords, alertWords, type AlertSubject, errorChanged, legacyLandFirstMarker, legacyMainRedMarker, legacyTrainAlertMarker, legacyTrainAlerts,
	legacyTrainLevel, openEpisode, urgencyOf,
} from "../src/alert-path";
import { alertSources, fsReportFiles, psProbe, type SourceSeams } from "../src/alert-sources";
import { field, type Gh, GhError, type GhResult, ghJsonOf, issueNumber, issueOps } from "../src/jo-issues";
import { ALERT_BY, alertBody, alertPopupBody, type AlertRow, controlEntries, heldLive } from "../src/launch";
import { checkoutOwnerRepo, everyTrain, landFirstRows, mainRedNotices, stopEpisode, TRAIN_ALERT_LABEL, TRAIN_ALERT_MENTION, TRAIN_ALERT_REPO, trainCheckout } from "../src/merge-train";
import { alertSpawnLog, BUN, type DetachedSpawn, spawnDetached, unboundEnv } from "../src/notify";
import { ompPidState, runPs } from "../src/omp-probe";
import { alertRows, commentMarker, issueMarker, quotaMoves } from "../src/quota-move-alert";
import { type QuotaWatchResult, quotaWatchDeps, runQuotaWatch } from "../src/quota-watch";
import { type LockRefusal, type RunnerLock, selfIdentity, takeRunnerLock } from "../src/runner-probe";
import { STANDING_WORKLOAD_ID } from "../src/types";
import {
	ALERT_POPUP_SCRIPT, groupKey, type LegacyClaim, legacyPopupRecord, type Member, parsePs, POPUP_TAG_ENV, popupAttempts, type PopupAttempt, popupStatus, popupTag,
	type Proc, psArgs, settleAttempt, settleLegacy, terminatingDetail,
} from "./alert-popup";

/** The popup's seams: the worker spawn, the ps reads, the signals. */
export interface PopupSeams {
	/** A detached start (surface/src/notify.ts `spawnDetached`); returns the pid or throws. */
	spawn: DetachedSpawn;
	/** The environment the worker starts with (the lane binding dropped); AS2_ALERT_POPUP is added per attempt. */
	env: Record<string, string>;
	/** The log the worker's streams append to. */
	log: string;
	/** `ps <args>`'s stdout (`psArgs(true)` with -E, `psArgs(false)` without); throws naming the failure (EPERM, exit, timeout). */
	ps: (args: string[]) => string;
	/** Signal one process: true when sent, false when it is already gone (ESRCH); any other failure throws. */
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
}

/** What one pass needs beside the ledger. */
export interface AlertPassDeps {
	ledger: Ledger;
	/** One gh call (AS2_ALERT_GH, 60 s at most), one attempt. */
	gh: Gh;
	log: (line: string) => void;
	/** The quota watch at the pass's clock (D7). */
	quota: (now: string) => QuotaWatchResult;
	/** The sources' file, process and repository seams; the pass adds the clock, urgency and popup answers. */
	sources: Pick<SourceSeams, "alarmFile" | "reportsDir" | "files" | "probe" | "trainRepo">;
	popup: PopupSeams;
}

/** What a pass came to: its problems (each names what broke, where, and the evidence); empty when it all went through. */
export interface AlertPassResult {
	problems: string[];
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
const HOUR_MS = 3_600_000;

/** A gh failure that stops one key for this pass. */
class KeyStop extends Error {}

/**
 * One alert pass over `d.ledger` (no lock: `lockedAlertPass` takes it). Never throws for one key's failure: that key's
 * error row is written and the rest go on; a failure of the pass itself (no standing workload, a ledger read) is returned.
 */
export function alertPass(d: AlertPassDeps): AlertPassResult {
	const { ledger } = d;
	const problems: string[] = [];
	const say = (l: string) => d.log(`alert pass: ${l}`);
	const problem = (l: string) => {
		problems.push(l);
		say(l);
	};
	if (!ledger.workload(STANDING_WORKLOAD_ID)) {
		problem(`${STANDING_WORKLOAD_ID}: no standing workload, so no alert row can be written: pass skipped`);
		return { problems };
	}
	const now = ledger.now();
	const write = (body: string): string => ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
	const alertRow = (key: string, row: AlertRow): string => write(alertBody(key, row));
	const standing = () => controlEntries(ledger.entries(STANDING_WORKLOAD_ID));
	const records = () => alertRecords(standing());

	// 1. The quota watch.
	const quota = d.quota(now);
	for (const l of quota.log) say(l);
	if (quota.error !== null) problems.push(quota.error);

	// 2. The sources.
	const control0 = standing();
	const inputRow = (id: string) => ledger.db.query<InstructionRow, [string]>("SELECT * FROM instructions WHERE id = ?").get(id) ?? null;
	const urgentCache = new Map<string, boolean>();
	const seams: SourceSeams = {
		...d.sources, now,
		urgent: (wl) => {
			if (!urgentCache.has(wl)) {
				const w = ledger.workload(wl);
				const u = w === null ? { urgent: false, from: null, unread: [] } : urgencyOf({ id: w.id, brief: w.brief }, ledger.instructions(wl), inputRow);
				if (u.unread.length > 0) say(`${wl}: the brief cites input ${u.unread.join(", ")}, which is not Jo's input row on this ledger: its urgency was not read from it`);
				urgentCache.set(wl, u.urgent);
			}
			return urgentCache.get(wl)!;
		},
		popupAnsweredAt: (key) => alertPopupAnsweredAt(control0, key),
	};
	const src = alertSources(ledger, seams);
	for (const p of src.problems) problem(`${p.source} source: ${p.error}`);
	let subjects: AlertSubject[] = [...quota.subjects, ...src.subjects];

	const ghJson = ghJsonOf(d.gh);
	const ops = issueOps(d.gh, ghJson);
	const marked = ops.marked;
	const view = (url: string, fields: string): unknown => ghJson(["issue", "view", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--json", fields]);
	const comments = (url: string): string[] => {
		const c = field(view(url, "comments"), "comments");
		if (!Array.isArray(c)) throw new GhError(`gh issue view ${url} --json comments returned no comments array`);
		return c.map((x) => field(x, "body")).filter((b): b is string => typeof b === "string");
	};
	let labels: Set<string> | null = null;
	const ensureLabels = (want: readonly string[]) => {
		if (labels === null) {
			const v = ghJson(["label", "list", "-R", TRAIN_ALERT_REPO, "--json", "name", "--limit", "1000"]);
			if (!Array.isArray(v)) throw new GhError(`gh label list -R ${TRAIN_ALERT_REPO} returned no array`);
			labels = new Set(v.map((l) => field(l, "name")).filter((n): n is string => typeof n === "string"));
		}
		for (const l of want) {
			if (labels.has(l)) continue;
			ops.run(["label", "create", l, "-R", TRAIN_ALERT_REPO, "--description", "filed by the as2 alert path"]);
			labels.add(l);
		}
	};

	/** An error row for `key` on `channel` (episode or not), written only when its text changed; and the log line. */
	const keyError = (key: string, channel: string, err: unknown) => {
		const text = errText(err);
		say(`${key}: ${channel}: ${text}`);
		try {
			const rec = records().get(key);
			const ep = openEpisode(rec);
			const loose = [...(rec?.loose ?? [])].reverse().find((r) => r.row.row === "error" && r.row.channel === channel);
			const changed = ep !== null ? errorChanged(ep, channel, text) : !(loose !== undefined && loose.row.row === "error" && loose.row.text === text);
			if (changed) alertRow(key, { row: "error", channel, text });
		} catch (writeErr) {
			problem(`${key}: the error row for ${channel} (${text}) could not be written: ${errText(writeErr)}`);
		}
	};

	// 3. Legacy adoption.
	const held = new Set<string>();
	const hasEpisode = (rec: AlertKeyRecord | undefined) => (rec?.episodes.length ?? 0) > 0;
	const active = new Set(subjects.map((s) => s.key));
	let rec0 = records();
	let legacyProcs: Proc[] | null = null;
	const legacyPs = (): Proc[] => (legacyProcs ??= parsePs(d.popup.ps(psArgs(false))));
	const adopt = (key: string, run: () => void) => {
		try {
			run();
		} catch (err) {
			held.add(key);
			keyError(key, err instanceof GhError ? "gh" : err instanceof KeyStop ? "popup" : "adoption", err);
		}
	};
	// 3a. Train questions.
	for (const wl of everyTrain(ledger)) {
		for (const a of legacyTrainAlerts(controlEntries(ledger.entries(wl))).values()) {
			const key = `q:${a.q}`;
			if (hasEpisode(rec0.get(key)) || (a.end !== null && !active.has(key))) continue;
			adopt(key, () => {
				const url = a.url ?? marked(legacyTrainAlertMarker(a.q, 1));
				const issue = url === null ? null : (() => {
					const v = view(url, "body,comments");
					const c = field(v, "comments");
					return { body: String(field(v, "body") ?? ""), comments: Array.isArray(c) ? c.map((x) => String(field(x, "body") ?? "")) : [] };
				})();
				const level = legacyTrainLevel(a, a.q, issue);
				ledger.write(() => {
					alertRow(key, { row: "adopted", url, level, from: `train-alert ${a.q} on ${wl}` });
					if (a.end !== null) alertRow(key, { row: a.end, why: `the retired train alert was ${a.end} before the cutover` });
				});
				say(`${key}: adopted the train alert on ${wl} at level ${level} (${url ?? "no issue found"})`);
			});
		}
	}
	// 3b. Quota moves: a legacy popup still on screen is settled first (D3 "Legacy popups at cutover").
	for (const move of quotaMoves(ledger)) {
		const key = `move:${move.eventId}`;
		if (hasEpisode(rec0.get(key))) continue;
		const rows = alertRows(ledger, move);
		if (rows.length === 0) continue;
		const popupRows = rows.filter((r) => r.channel === "popup");
		const last = popupRows.at(-1);
		const claimRow = [...popupRows].reverse().find((r) => r.status === "claim");
		const unsettled = last !== undefined && (last.status === "claim" || last.status === "showing") && claimRow !== undefined;
		const legacyTexts = (rec0.get(key)?.loose ?? []).flatMap((r) => (r.row.row === "legacy-popup" ? [r.row.text] : []));
		const lrec = legacyPopupRecord(legacyTexts);
		if (unsettled && lrec.settled === null) {
			adopt(key, () => {
				const pid = Number(/pid=(\d+)/.exec(claimRow!.rest)?.[1]);
				const claim: LegacyClaim = { pid, attempt: Number(/attempt=(\d+)/.exec(claimRow!.rest)?.[1] ?? 0) };
				const step = settleLegacy(lrec, legacyPs(), claim, move, now);
				if (step === null) throw new KeyStop(`the legacy popup of ${move.eventId} is being settled (terminating members recorded); adoption waits`);
				if (step.do === "error") throw new KeyStop(step.text);
				if (step.do === "terminate" || step.do === "kill") {
					const failed = signal(step.members, step.do === "terminate" ? "SIGTERM" : "SIGKILL");
					alertRow(key, { row: "legacy-popup", text: step.text });
					if (failed.length > 0) throw new KeyStop(`signalling the legacy popup of ${move.eventId} failed: ${failed.join("; ")}`);
					throw new KeyStop(`the legacy popup of ${move.eventId} was signalled (${step.text}); adoption waits for its members to go`);
				}
				alertRow(key, { row: "legacy-popup", text: step.text });
			});
			if (held.has(key)) continue;
		}
		if (!active.has(key)) continue;
		adopt(key, () => {
			const url = marked(issueMarker(move.eventId));
			const level = url === null ? 0 : comments(url).some((c) => c.includes(commentMarker(move.eventId))) ? 2 : 1;
			const ok = popupRows.filter((r) => r.status === "ok").at(-1);
			ledger.write(() => {
				const ep = alertRow(key, { row: "adopted", url, level, from: `quota-move-alert ${move.eventId} on ${move.workloadId}` });
				if (ok !== undefined) write(alertPopupBody(key, ep, 2, "ok", `legacy ${ok.rest || "answered"} at ${ok.at}`));
			});
			say(`${key}: adopted the move alert at level ${level} (${url ?? "no issue found"})${ok ? "; its legacy popup was answered" : ""}`);
		});
	}
	// 3c. main:<repo>: a land-first stop's issue and a main-red notice's issue; the open stop's is canonical (r5 #1).
	{
		const entries = ledger.entries(STANDING_WORKLOAD_ID);
		const byKey = new Map<string, { ref: string; url: string; stop: boolean }[]>();
		const refsOf = (key: string) => byKey.get(key) ?? (byKey.set(key, []), byKey.get(key)!);
		const rows = landFirstRows(entries);
		for (const repo of [...new Set(rows.map((r) => r.repo))].sort()) {
			const key = `main:${repo}`;
			if (hasEpisode(rec0.get(key))) continue;
			const ep = stopEpisode(rows.filter((r) => r.repo === repo));
			if (ep === null || ep.state.kind === "depth") continue;
			adopt(key, () => {
				const url = ep.filed ?? marked(legacyLandFirstMarker(repo, ep.raised.entryId));
				if (url !== null) refsOf(key).push({ ref: `land-first stop ${ep.raised.entryId}`, url, stop: true });
			});
		}
		for (const n of mainRedNotices(ledger).values()) {
			const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(n.url);
			if (n.cleared !== null || !m) continue;
			const key = `main:${m[1]!.toLowerCase()}`;
			if (hasEpisode(rec0.get(key)) || held.has(key)) continue;
			adopt(key, () => {
				const url = n.issue ?? marked(legacyMainRedMarker(n.url));
				if (url !== null && !refsOf(key).some((r) => r.url === url)) refsOf(key).push({ ref: `main-red ${n.url}`, url, stop: false });
			});
		}
		for (const [key, refs] of byKey) {
			if (held.has(key) || refs.length === 0) continue;
			const canonical = refs.find((r) => r.stop) ?? refs[0]!;
			adopt(key, () => {
				ledger.write(() => {
					alertRow(key, { row: "adopted", url: canonical.url, level: 1, from: canonical.ref });
					for (const r of refs) if (r !== canonical) alertRow(key, { row: "merged", url: r.url, into: canonical.url });
				});
				say(`${key}: adopted ${canonical.url} (${canonical.ref})${refs.length > 1 ? `; merging ${refs.filter((r) => r !== canonical).map((r) => r.url).join(", ")} into it` : ""}`);
			});
		}
	}
	subjects = subjects.filter((s) => !held.has(s.key));

	// 4. The actions and their effects.
	rec0 = records();
	const stopped = new Set<string>(held);
	const issueStates = new Map<string, "OPEN" | "CLOSED">();
	for (const [key, rec] of rec0) {
		const ep = openEpisode(rec);
		if (ep === null || ep.acked !== null || ep.url === null || stopped.has(key)) continue;
		try {
			const state = field(view(ep.url, "state"), "state");
			if (state !== "OPEN" && state !== "CLOSED") throw new GhError(`gh issue view ${ep.url} --json state answered ${JSON.stringify(state)}`);
			issueStates.set(ep.id, state);
		} catch (err) {
			stopped.add(key);
			keyError(key, "gh", err);
		}
	}
	const acks: AlertAck[] = [];
	for (const wl of new Set([STANDING_WORKLOAD_ID, ...subjects.flatMap((s) => (s.workloadId === null ? [] : [s.workloadId]))])) acks.push(...alertAcks(ledger.instructions(wl)));
	acks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const cleared = new Map<string, string>();
	for (const [key, rec] of rec0) if (openEpisode(rec) !== null && !active.has(key)) cleared.set(key, clearedWhy(ledger, key, now));
	let actions: AlertAction[];
	try {
		actions = alertActions(subjects.filter((s) => !stopped.has(s.key)), new Map([...rec0].filter(([k]) => !stopped.has(k))), { issueStates, acks, cleared }, now);
	} catch (err) {
		problem(`alertActions failed, so no alert was sent this pass: ${errText(err)}`);
		return { problems };
	}
	const keyOf = (a: AlertAction) => (a.kind === "close" ? a.key : a.subject.key);
	for (const a of actions) {
		const key = keyOf(a);
		if (stopped.has(key)) continue;
		try {
			effect(a);
		} catch (err) {
			stopped.add(key);
			keyError(key, err instanceof GhError ? "gh" : "pass", err);
		}
	}
	// Merged legacy issues: a pointer comment, the close, then `merged-closed` (r5 #1).
	for (const [key, rec] of records()) {
		const ep = openEpisode(rec);
		if (ep === null || stopped.has(key)) continue;
		for (const [url, m] of ep.merged) {
			if (m.closedAt !== null) continue;
			try {
				const marker = alertMarker(key, ep.id, "merged-into");
				if (!comments(url).some((c) => c.includes(marker))) ops.run(["issue", "comment", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--body", `${marker}\nMerged into ${m.into}: this alert continues there (as2).`]);
				if (field(view(url, "state"), "state") !== "CLOSED") ops.run(["issue", "close", issueNumber(url), "-R", TRAIN_ALERT_REPO]);
				alertRow(key, { row: "merged-closed", url });
				say(`${key}: ${url} closed, merged into ${m.into}`);
			} catch (err) {
				stopped.add(key);
				keyError(key, err instanceof GhError ? "gh" : "pass", err);
				break;
			}
		}
	}

	// 5. The popups.
	popups();
	return { problems };

	/** One action's effects; throws a GhError on a gh failure (the caller writes the key's error and stops the key). */
	function effect(a: AlertAction): void {
		if (a.kind === "raise") {
			alertRow(a.subject.key, { row: "raised", kind: a.subject.kind, start: a.subject.startLevel, digest: a.digest, words: alertWords(a.subject) });
			say(`${a.subject.key}: raised (${a.subject.kind}, start ${a.subject.startLevel}): ${a.subject.title}`);
			return;
		}
		if (a.kind === "close") {
			const ep = a.episode;
			const url = ep.url ?? (ep.sending.has(1) ? marked(alertMarker(a.key, ep.id, "create")) : null);
			if (url !== null && ep.acked === null && field(view(url, "state"), "state") !== "CLOSED") {
				ops.run(["issue", "close", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--comment", `${a.why} (as2).`]);
			}
			alertRow(a.key, { row: "closed", why: a.why });
			say(`${a.key}: closed (${a.why})${url ? `: ${url}` : ""}`);
			return;
		}
		const s = a.subject;
		const ep = a.kind === "send" && a.episode === null ? openEpisode(records().get(s.key)) : a.episode;
		if (ep === null) throw new Error(`${s.key}: no open episode after its raise`);
		if (a.kind === "ack") {
			if (a.by === "word" && ep.url !== null && field(view(ep.url, "state"), "state") !== "CLOSED") {
				ops.run(["issue", "close", issueNumber(ep.url), "-R", TRAIN_ALERT_REPO, "--comment", `Acknowledged in as2: ${a.why}.`]);
			}
			alertRow(s.key, { row: "acked", why: a.why });
			say(`${s.key}: acked (${a.why})`);
			return;
		}
		if (a.kind === "update") {
			const url = ep.url!;
			const marker = alertMarker(s.key, ep.id, `update ${a.digest}`);
			if (!comments(url).some((c) => c.includes(marker))) {
				ops.run(["issue", "comment", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--body", `${marker}\nUpdated (as2): ${s.title}\n\n${s.text}\n\nNext: ${s.next}`]);
			}
			alertRow(s.key, { row: "updated", digest: a.digest, words: alertWords(s) });
			say(`${s.key}: updated on ${url}`);
			return;
		}
		// send
		const level = a.level;
		if (!ep.sending.has(level)) alertRow(s.key, { row: "level", level, step: "sending", url: null });
		if (level === 1) {
			const marker = alertMarker(s.key, ep.id, "create");
			let url = ep.url ?? marked(marker);
			if (url === null) {
				ensureLabels([TRAIN_ALERT_LABEL]);
				const body = [
					marker, s.text, "", `Next: ${s.next}`, "",
					`Alert ${s.key}. Closing this issue acknowledges the alert and stops the re-sends at 4 h and 8 h (so does \`ack ${s.key}\` in as2); it answers nothing.`,
				].join("\n");
				const out = ops.run(["issue", "create", "-R", TRAIN_ALERT_REPO, "--label", TRAIN_ALERT_LABEL, "--title", s.title, "--body", body]);
				url = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
				issueNumber(url);
			}
			alertRow(s.key, { row: "level", level: 1, step: "sent", url });
			say(`${s.key}: level 1: ${url}`);
			return;
		}
		const url = ep.url ?? marked(alertMarker(s.key, ep.id, "create"));
		if (url === null) throw new Error(`${s.key}: level ${level} is due but level 1's issue is not recorded and no issue carries its marker`);
		const step = a.step;
		const marker = alertMarker(s.key, ep.id, `level ${level}`);
		if (!comments(url).some((c) => c.includes(marker))) {
			const first = ep.sent.get(1);
			const late = first !== undefined && Date.parse(now) - Date.parse(first) >= step.afterMs;
			const when = late ? `unacknowledged ${step.afterMs / HOUR_MS} h` : "needs you now";
			ops.run(["issue", "comment", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--body", `${marker}\n${TRAIN_ALERT_MENTION} ${when}: ${s.title}. ${s.next}. Close this issue to acknowledge.`]);
		}
		ensureLabels(step.labels);
		ops.run(["issue", "edit", issueNumber(url), "-R", TRAIN_ALERT_REPO, "--add-label", step.labels.join(",")]);
		alertRow(s.key, { row: "level", level, step: "sent", url: null });
		say(`${s.key}: level ${level} on ${url}`);
	}

	/** SIGTERM or SIGKILL each member; the failures, each naming its pid. */
	function signal(members: readonly Proc[], sig: "SIGTERM" | "SIGKILL"): string[] {
		const failed: string[] = [];
		for (const p of members) {
			try {
				d.popup.kill(p.pid, sig);
			} catch (err) {
				failed.push(`${sig} ${p.pid}: ${errText(err)}`);
			}
		}
		return failed;
	}

	/** Step 5: settle every unsettled attempt, then spawn a worker for each sent level with a popup that has none. */
	function popups(): void {
		const recs = records();
		const groups = popupAttempts(alertPopupRows(standing()));
		const unsettled = [...groups.values()].flatMap((list) => list.filter((a) => a.end === null));
		const busy = new Set<string>();
		if (unsettled.length > 0) {
			let procs: Proc[] | null = null;
			try {
				procs = parsePs(d.popup.ps(psArgs(true)));
			} catch (err) {
				for (const k of new Set(unsettled.map((a) => a.key))) {
					busy.add(k);
					keyError(k, "popup", `ps -A -E could not be read, so no popup was settled: ${errText(err)}`);
				}
			}
			if (procs !== null) for (const a of unsettled) settle(a, procs, recs, busy);
		}
		for (const [key, rec] of recs) {
			const ep = openEpisode(rec);
			if (ep === null || ep.acked !== null || busy.has(key) || stopped.has(key) || unsettled.some((a) => a.key === key)) continue;
			const level = Math.max(0, ...ep.sent.keys());
			if (level === 0 || !ALERT_LADDER[level - 1]!.channels.includes("popup")) continue;
			const st = popupStatus(groups.get(groupKey(key, ep.id, level)));
			if (st.ok || st.unsettled !== null || st.failures >= ALERT_POPUP_ATTEMPTS) continue;
			const attempt = st.failures + 1;
			try {
				write(alertPopupBody(key, ep.id, level, "spawning", `attempt=${attempt}`));
				const pid = d.popup.spawn([BUN, ALERT_POPUP_SCRIPT, key, ep.id, String(level)], { ...d.popup.env, [POPUP_TAG_ENV]: popupTag({ episode: ep.id, level, attempt }) }, d.popup.log);
				say(`${key}: level ${level} popup attempt ${attempt} spawned (pid ${pid})`);
			} catch (err) {
				try {
					write(alertPopupBody(key, ep.id, level, "unstarted", `spawn failed: ${errText(err)}`));
				} catch (rowErr) {
					problem(`${key}: the unstarted row of popup attempt ${attempt} could not be written: ${errText(rowErr)}`);
				}
				keyError(key, "popup", `the popup worker could not be spawned: ${errText(err)}`);
			}
		}
	}

	/** One unsettled attempt's settlement (D3): signals to its proven members, its rows. */
	function settle(a: PopupAttempt, procs: Proc[], recs: Map<string, AlertKeyRecord>, busy: Set<string>): void {
		const ep = recs.get(a.key)?.episodes.find((e) => e.id === a.episode) ?? null;
		const top = ep === null ? 0 : Math.max(0, ...ep.sent.keys());
		const cancel = ep === null ? "its episode is not on the ledger" : ep.closed !== null ? `closed: ${ep.closed.why}` : ep.acked !== null ? `acked: ${ep.acked.why}` : top > a.level ? `superseded by level ${top}` : null;
		const row = (step: Parameters<typeof alertPopupBody>[3], detail: string) => write(alertPopupBody(a.key, a.episode, a.level, step, detail));
		try {
			for (const s of settleAttempt(a, procs, now, cancel)) {
				if (s.do === "end") {
					row(s.step, s.detail);
					say(`${a.key}: level ${a.level} popup attempt ${a.attempt} ${s.step}: ${s.detail}`);
					continue;
				}
				busy.add(a.key);
				const failed = signal(s.members, s.do === "terminate" ? "SIGTERM" : "SIGKILL");
				if (s.do === "terminate") row("terminating", terminatingDetail(s.why, s.members as Member[], now));
				say(`${a.key}: level ${a.level} popup attempt ${a.attempt}: ${s.do === "terminate" ? "SIGTERM" : "SIGKILL"} to ${s.members.map((p) => p.pid).join(", ")}`);
				if (failed.length > 0) keyError(a.key, "popup", `signalling popup attempt ${a.attempt} failed: ${failed.join("; ")}`);
			}
		} catch (err) {
			busy.add(a.key);
			keyError(a.key, "popup", `settling popup attempt ${a.attempt} failed: ${errText(err)}`);
		}
	}
}

/** Why a key that is no longer a subject cleared, when the ledger says (the close comment names it). */
function clearedWhy(ledger: Ledger, key: string, now: string): string {
	const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
	if (kind === "q") {
		const q = ledger.question(id);
		if (q === null) return `question ${id} is not on the ledger`;
		if (q.state === "answered") {
			const answer = q.resolved_by ? ledger.instructions(q.workload_id).find((i) => i.id === q.resolved_by)?.body.trim() : undefined;
			return `Jo answered ${answer ?? "it"} (${id})`;
		}
		return `question ${id} was ${q.state}`;
	}
	if (id.startsWith("wl-")) {
		const w = ledger.workload(id);
		if (w === null) return `${id} is not on the ledger`;
		if (w.status !== "open") return `${id} is ${w.status}`;
		if (heldLive(w, now)) return `${w.holder} holds it`;
	}
	return `${key} is no longer active`;
}

/** The pass lock's path: `~/.agent-system-2/alert-pass.lock`. */
export function alertLockPath(env: Record<string, string | undefined> = process.env): string {
	return join(homeDir(env), ".agent-system-2", "alert-pass.lock");
}

/** The lock's seam: take it (a held lock, released after the pass) or a refusal naming its owner. */
export type AlertLock = () => Pick<RunnerLock, "release"> | LockRefusal;

/** The real lock: `takeRunnerLock` at `path` for this process (pid and ps start time), owner checked as the runner's is. */
export function realAlertLock(ledger: Ledger, path: string): AlertLock {
	return () => takeRunnerLock(ledger, path, selfIdentity(), (pid, start) => ompPidState(pid, start));
}

/**
 * One pass under the lock. Returns null when another pass holds it (one log line; the next tick or kick does the work), else
 * the pass's result. The lock is released whatever the pass did; a release failure never hides the pass's own error.
 */
export function lockedAlertPass(d: AlertPassDeps, lock: AlertLock): AlertPassResult | null {
	const held = lock();
	if (!("release" in held)) {
		d.log(`alert pass: another pass holds the lock (owner ${held.owner === null ? "unknown" : `pid ${held.owner.pid} started ${held.owner.start}`}, ${held.state}): not run; the next tick or kick does the work`);
		return null;
	}
	let result: AlertPassResult | undefined;
	let passErr: unknown;
	try {
		result = alertPass(d);
	} catch (err) {
		passErr = err;
	}
	try {
		held.release();
	} catch (err) {
		if (passErr !== undefined) throw new AggregateError([passErr, err], `alert pass failed: ${errText(passErr)}; releasing its lock also failed: ${errText(err)}`);
		throw new Error(`alert pass: releasing the lock failed: ${errText(err)}`);
	}
	if (passErr !== undefined) throw passErr;
	return result!;
}

// ---- the real seams -----------------------------------------------------------------------------

/** gh from AS2_ALERT_GH (else `gh` on PATH), 60 s at most, one attempt. */
export function realAlertGh(env: Record<string, string | undefined> = process.env): Gh {
	const bin = env.AS2_ALERT_GH || "gh";
	return (args: string[]): GhResult => {
		try {
			const r = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
			return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.exitedDueToTimeout ? `${bin} timed out after 60 s and was killed` : r.stderr.toString() };
		} catch (err) {
			return { code: 127, stdout: "", stderr: `${bin} could not be started: ${errText(err)}` };
		}
	};
}

/** `ps <args>` over runPs; throws naming the exit and stderr. */
export function realPs(args: string[]): string {
	const r = runPs(args);
	if (r.exitCode !== 0) throw new Error(`ps ${args.join(" ")} exited ${r.exitCode ?? "on a signal"}: ${r.stderr.trim() || "no error text"}`);
	return r.stdout;
}

/** process.kill; ESRCH (already gone) is `false`, any other failure throws. */
export function realKill(pid: number, sig: "SIGTERM" | "SIGKILL"): boolean {
	try {
		process.kill(pid, sig);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw err;
	}
}

/** The chaos reports dir: AS2_CHAOS_REPORTS, else surface/scripts/chaos.ts's REPORTS_DIR (`~/agent-scratch/agent-system-2.0/chaos`). */
export const chaosReportsDir = (env: Record<string, string | undefined>): string => env.AS2_CHAOS_REPORTS || join(homedir(), "agent-scratch", "agent-system-2.0", "chaos");

/** A train's GitHub `owner/repo` from its recorded checkout's origin, as the tick reads it when step 1 has none. */
export const checkoutTrainRepo = (ledger: Ledger) => (wl: string): string | null => {
	const c = trainCheckout(ledger, wl);
	return c === null ? null : (checkoutOwnerRepo(c)?.toLowerCase() ?? null);
};

/** Every seam but the ledger, the log and the train repository, from `env`: what train-tick.ts and main share. */
export function realAlertSeams(env: Record<string, string | undefined> = process.env): Omit<AlertPassDeps, "ledger" | "log" | "sources"> & { sources: Omit<AlertPassDeps["sources"], "trainRepo"> } {
	return {
		gh: realAlertGh(env),
		quota: (now) => runQuotaWatch(quotaWatchDeps(env, Date.parse(now))),
		sources: { alarmFile: alarmFilePath(env), reportsDir: chaosReportsDir(env), files: fsReportFiles, probe: psProbe },
		popup: { spawn: spawnDetached, env: unboundEnv(env), log: alertSpawnLog(env), ps: realPs, kill: realKill },
	};
}

/** `bun surface/scripts/alert-tick.ts [--kicked-by <why>]`: one locked pass on the ledger AGENT_SYSTEM_LEDGER_DB names. 0 when it ran clean or the lock was held, 1 when it had problems, 2 on bad arguments. */
export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
	if (!(argv.length === 0 || (argv.length === 2 && argv[0] === "--kicked-by"))) {
		process.stderr.write("usage: bun surface/scripts/alert-tick.ts [--kicked-by <why>]\n");
		return 2;
	}
	const log = (l: string) => process.stdout.write(`${new Date().toISOString()} ${l}\n`);
	if (argv[1]) log(`alert pass: kicked by ${argv[1]}`);
	const ledger = Ledger.open(defaultLedgerPath(env), { backupOnOpen: false });
	try {
		const seams = realAlertSeams(env);
		const r = lockedAlertPass({ ...seams, ledger, log, sources: { ...seams.sources, trainRepo: checkoutTrainRepo(ledger) } }, realAlertLock(ledger, alertLockPath(env)));
		return r === null || r.problems.length === 0 ? 0 : 1;
	} finally {
		ledger.close();
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
