// The cutover (PLAN wl-mw0vs9uc3xqtka D3 "Legacy adoption"; R16, R23): an alert a retired path already filed is adopted by the
// alert pass, never filed a second time; two legacy issues on one key keep the open stop's as canonical and close the other;
// a legacy quota-move popup still on screen is settled first, by identity alone. A temp ledger, the recording gh of
// alert-world.ts and fake ps snapshots; nothing real is filed, shown or signalled.
import { describe, expect, test } from "bun:test";
import { LANE_RUNNER_BY } from "../../ledger/src/index";
import { alertMarker, alertRecords, openEpisode } from "../src/alert-path";
import { errorLines } from "../src/errors";
import { controlEntries, laneHeadroomBody } from "../src/launch";
import { landFirstNoticeBody, mainRedNoticeBody } from "../src/merge-train";
import { commentMarker, issueMarker, moveText, moveTitle, POPUP_SCRIPT, QUOTA_MOVE_ALERT_PREFIX, quotaMoves, recordQuotaMove } from "../src/quota-move-alert";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { alertPass } from "../scripts/alert-tick";
import { type AlertWorld, ISSUE, world } from "./alert-world";

const A = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6-sol";

describe("a quota move the retired path already alerted (D3 legacy adoption)", () => {
	test("its jo-issues issue and level-2 comment are adopted at level 2: no second issue, no level re-send, no popup; one update comment carries the current text", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = recordQuotaMove(w.ledger, { workloadId: wl, laneId: "lane-a-1", kind: "lane", from: A, to: SOL, reason: "5h window at 97 %", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-a-1", A, SOL, "5h window at 97 %") });
		// What the retired worker left: its ledger rows, the issue with its marker, and the level-2 comment with its own.
		for (const body of [`${QUOTA_MOVE_ALERT_PREFIX} ${e} comment sent ${ISSUE}`, `${QUOTA_MOVE_ALERT_PREFIX} ${e} popup ok Dismiss`]) w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		w.g.issues.push({ url: ISSUE, title: "quota move", body: `moved\n${issueMarker(e)}`, state: "OPEN", comments: [`level 2\n${commentMarker(e)}`], labels: ["as2-train"] });
		alertPass(w.deps);
		const key = `move:${e}`;
		const rows = w.rows().filter((r) => r.startsWith(`alert: ${key} `));
		expect(rows[0]).toStartWith(`alert: ${key} adopted `);
		expect(rows[0]).toContain(ISSUE);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep.url).toBe(ISSUE);
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.calls.filter((a) => a[0] === "issue" && a[1] === "create")).toEqual([]);
		// The legacy level-2 comment stands; the pass adds only its update (the text it now holds), never a level comment.
		const added = w.g.issues[0]!.comments.slice(1);
		expect(added).toHaveLength(1);
		expect(added[0]).toContain(`<!-- as2-alert ${key} ${ep.id} update `);
		expect(rows.filter((r) => r.startsWith(`alert: ${key} level `))).toEqual([]);
		// A second pass sends nothing more.
		alertPass(w.deps);
		expect(w.g.issues[0]!.comments).toHaveLength(2);
		// The legacy popup was answered: the pass records it at level 2 and shows no second popup.
		expect(w.rows().filter((r) => r.startsWith(`alert-popup: ${key} ${ep.id} 2 ok legacy Dismiss at `))).toHaveLength(1);
		expect(w.spawns).toEqual([]);
	});

	test("a move with no legacy issue is filed fresh by the pass, once", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = recordQuotaMove(w.ledger, { workloadId: wl, laneId: "lane-a-1", kind: "lane", from: A, to: SOL, reason: "5h window at 97 %", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-a-1", A, SOL, "5h window at 97 %") });
		alertPass(w.deps);
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		expect(w.g.issues[0]!.body).toContain(`move:${e}`);
	});
});

describe("main:<repo> with two legacy issues (D3 r5 #1, R16)", () => {
	const REPO = "thewolff/agent-system-2.0";
	const KEY = `main:${REPO}`;
	const SOURCE = `https://github.com/${REPO}/issues/500`;
	const RED_ISSUE = "https://github.com/thewolff/jo-issues/issues/90";
	const STOP_ISSUE = "https://github.com/thewolff/jo-issues/issues/91";
	/** What the retired mainRedPass and landingPass left: their rows, and the open issues they filed. */
	function legacyMain(w: AlertWorld, o: { red: boolean; stop: boolean }): void {
		const put = (body: string) => w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		if (o.red) {
			put(mainRedNoticeBody(SOURCE, "raised", "run 123"));
			put(mainRedNoticeBody(SOURCE, "filed", RED_ISSUE));
			w.g.issues.push({ url: RED_ISSUE, title: "main is red", body: "main-red", state: "OPEN", comments: [], labels: ["as2-train"] });
		}
		if (o.stop) {
			put(landFirstNoticeBody(REPO, { event: "stop-raised", kind: "regression", tip: "a".repeat(40), g: null, suspects: [12], failing: 1 }));
			put(landFirstNoticeBody(REPO, { event: "stop-filed", url: STOP_ISSUE }));
			w.g.issues.push({ url: STOP_ISSUE, title: "landing stopped", body: "land-first", state: "OPEN", comments: [], labels: ["as2-train"] });
		}
	}
	const issue = (w: AlertWorld, url: string) => w.g.issues.find((i) => i.url === url)!;
	const keyRows = (w: AlertWorld) => w.rows().filter((r) => r.startsWith(`alert: ${KEY} `));

	test("the open stop's issue is canonical; the main-red issue gets one pointer comment, is closed, and `merged-closed` is written", () => {
		const w = world();
		legacyMain(w, { red: true, stop: true });
		alertPass(w.deps);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(KEY))!;
		expect(ep).toMatchObject({ opened: "adopted", url: STOP_ISSUE });
		expect(keyRows(w).filter((r) => / (adopted|merged|merged-closed) /.test(r))).toEqual([
			expect.stringMatching(new RegExp(`^alert: ${KEY} adopted ${STOP_ISSUE} level 1 from land-first stop `)),
			`alert: ${KEY} merged ${RED_ISSUE} into ${STOP_ISSUE}`,
			`alert: ${KEY} merged-closed ${RED_ISSUE}`,
		]);
		expect(issue(w, RED_ISSUE).state).toBe("CLOSED");
		expect(issue(w, RED_ISSUE).comments).toEqual([`${alertMarker(KEY, ep.id, "merged-into")}\nMerged into ${STOP_ISSUE}: this alert continues there (as2).`]);
		expect(issue(w, STOP_ISSUE).state).toBe("OPEN");
		expect(w.g.calls.filter((a) => a[0] === "issue" && a[1] === "create")).toEqual([]);
		alertPass(w.deps);
		expect(issue(w, RED_ISSUE).comments).toHaveLength(1);
		expect(keyRows(w).filter((r) => r.includes(" merged-closed "))).toHaveLength(1);
	});

	test("with only one legacy issue, that one is canonical and nothing is merged", () => {
		for (const [o, url] of [[{ red: true, stop: false }, RED_ISSUE], [{ red: false, stop: true }, STOP_ISSUE]] as const) {
			const w = world();
			legacyMain(w, o);
			alertPass(w.deps);
			expect(openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(KEY))).toMatchObject({ opened: "adopted", url });
			expect(keyRows(w).filter((r) => r.includes(" merged"))).toEqual([]);
			expect(w.g.issues.map((i) => i.state)).toEqual(["OPEN"]);
		}
	});

	test("a merged issue whose cleanup failed is still closed after the canonical episode closes (review r1 #5)", () => {
		let down = true;
		const w = world({ fail: (a) => down && a[0] === "issue" && a[1] === "comment" && a[2] === "90" });
		legacyMain(w, { red: true, stop: true });
		alertPass(w.deps);
		expect(keyRows(w).filter((r) => r.includes(" merged-closed "))).toEqual([]);
		expect(keyRows(w).filter((r) => r.startsWith(`alert: ${KEY} error gh `))).toHaveLength(1);
		// Main goes green: the stop and the notice clear, so the canonical episode closes this pass.
		const put = (body: string) => w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		put(landFirstNoticeBody(REPO, { event: "stop-cleared", why: "main is green again" }));
		put(mainRedNoticeBody(SOURCE, "cleared", "the source issue was closed"));
		down = false;
		w.c.plusHours(0.01);
		alertPass(w.deps);
		expect(keyRows(w).filter((r) => r.startsWith(`alert: ${KEY} closed `))).toHaveLength(1);
		expect(issue(w, STOP_ISSUE).state).toBe("CLOSED");
		expect(issue(w, RED_ISSUE).state).toBe("CLOSED");
		expect(keyRows(w).filter((r) => r === `alert: ${KEY} merged-closed ${RED_ISSUE}`)).toHaveLength(1);
	});
});

describe("pre-adoption failures are on the needs-you surface (D3, R11)", () => {
	test("a marker lookup that fails holds the key with an ALERT line naming it; no issue is filed and no popup starts until it is adopted (review r1 #6)", () => {
		let down = true;
		const w = world({ fail: (a) => down && a[0] === "api" });
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = recordQuotaMove(w.ledger, { workloadId: wl, laneId: "lane-a-1", kind: "lane", from: A, to: SOL, reason: "5h window at 97 %", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-a-1", A, SOL, "5h window at 97 %") });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `${QUOTA_MOVE_ALERT_PREFIX} ${e} comment sent ${ISSUE}` });
		const key = `move:${e}`;
		const alertLines = () => errorLines(w.ledger).filter((l) => l.kind === "alert");
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} error gh `))).toHaveLength(1);
		expect(alertLines()).toHaveLength(1);
		expect(alertLines()[0]!.line).toContain(key);
		expect(alertLines()[0]!.line).toContain("HTTP 502");
		expect(w.g.calls.filter((a) => a[0] === "issue" && a[1] === "create")).toEqual([]);
		expect(w.spawns).toEqual([]);
		down = false;
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} adopted `))).toHaveLength(1);
		expect(alertLines().filter((l) => l.line.includes("HTTP 502"))).toEqual([]);
	});
});

describe("a legacy quota-move popup still on screen at cutover (D3, R16, R23)", () => {
	const LS = "Tue Nov  3 10:00:00 2026";
	const LATER = "Tue Nov  3 10:05:00 2026";
	/** A move the retired path was still showing: its claim row (owner pid 900), and the snapshot `ps` returns. */
	function legacyPopup() {
		let snapshot = "";
		const w = world({ ps: () => snapshot });
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "Fix it", stakes: "normal", mode: "autonomous" });
		const e = recordQuotaMove(w.ledger, { workloadId: wl, laneId: "lane-a-1", kind: "lane", from: A, to: SOL, reason: "5h window at 97 %", by: LANE_RUNNER_BY, eventBody: laneHeadroomBody("lane-a-1", A, SOL, "5h window at 97 %") });
		w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body: `${QUOTA_MOVE_ALERT_PREFIX} ${e} popup claim pid=900 attempt=1` });
		const move = quotaMoves(w.ledger).find((m) => m.eventId === e)!;
		return {
			w, key: `move:${e}`, set: (lines: string[]) => void (snapshot = lines.join("\n")),
			owner: `/opt/homebrew/bin/bun /Users/jo/code/as2/surface/scripts/lane.ts move-alert ${wl} ${e}`,
			dialog: `/usr/bin/osascript ${POPUP_SCRIPT.map((l) => `-e ${l}`).join(" ")} ${moveTitle(move)} ${moveText(move)}`,
			voice: `/usr/bin/say ${moveText(move)}`,
		};
	}
	const plusSeconds = (w: AlertWorld, s: number) => w.c.plusHours(s / 3600);
	const adopted = (w: AlertWorld, key: string) => w.rows().filter((r) => r.startsWith(`alert: ${key} adopted `));

	test("the owner and its dialog get SIGTERM; a voice seen later is folded in; SIGKILL after 30 s each; adopted and shown only once every helper is gone (review r1 #2)", () => {
		const p = legacyPopup();
		const { w, key } = p;
		p.set([`  900     1   900 ${LS} ${p.owner}`, `  901   900   900 ${LS} ${p.dialog}`, `  950     1   950 ${LS} /bin/sleep 5`]);
		alertPass(w.deps);
		expect(w.kills.toSorted((a, b) => a[0] - b[0])).toEqual([[900, "SIGTERM"], [901, "SIGTERM"]]);
		expect(adopted(w, key)).toEqual([]);
		expect(errorLines(w.ledger).filter((l) => l.kind === "alert" && l.line.includes(key))).toHaveLength(1);
		// 10 s on: the owner is gone, its dialog is still up, and the move's voice has started.
		plusSeconds(w, 10);
		p.set([`  901     1   900 ${LS} ${p.dialog}`, `  902     1   902 ${LATER} ${p.voice}`, `  950     1   950 ${LS} /bin/sleep 5`]);
		alertPass(w.deps);
		expect(w.kills.slice(2)).toEqual([[902, "SIGTERM"]]);
		plusSeconds(w, 21);
		alertPass(w.deps);
		expect(w.kills.slice(3)).toEqual([[901, "SIGKILL"]]);
		expect(adopted(w, key)).toEqual([]);
		plusSeconds(w, 10);
		p.set([`  902     1   902 ${LATER} ${p.voice}`, `  950     1   950 ${LS} /bin/sleep 5`]);
		alertPass(w.deps);
		expect(w.kills.slice(4)).toEqual([[902, "SIGKILL"]]);
		expect(adopted(w, key)).toEqual([]);
		expect(w.g.issues).toEqual([]);
		expect(w.spawns).toEqual([]);
		p.set([`  950     1   950 ${LS} /bin/sleep 5`]);
		alertPass(w.deps);
		expect(w.rows()).toContain(`alert: ${key} legacy-popup settled cancelled at cutover`);
		expect(adopted(w, key)).toHaveLength(1);
		expect(w.g.issues).toHaveLength(1);
		expect(w.spawns).toHaveLength(1);
		expect(w.kills.some(([pid]) => pid === 950)).toBe(false);
	});

	test("a reused owner pid leading an unrelated group with a child is never signalled, while the move's own dialog is settled (R23)", () => {
		const p = legacyPopup();
		const { w, key } = p;
		p.set([`  900     1   900 ${LATER} /usr/bin/vim notes.txt`, `  905   900   900 ${LATER} /bin/sh -c make`, `  901     1   901 ${LS} ${p.dialog}`]);
		alertPass(w.deps);
		expect(w.kills).toEqual([[901, "SIGTERM"]]);
		p.set([`  900     1   900 ${LATER} /usr/bin/vim notes.txt`, `  905   900   900 ${LATER} /bin/sh -c make`]);
		alertPass(w.deps);
		expect(w.kills).toEqual([[901, "SIGTERM"]]);
		expect(w.rows()).toContain(`alert: ${key} legacy-popup settled cancelled at cutover`);
		expect(adopted(w, key)).toHaveLength(1);
	});

	test("a pid reused between passes is not killed: the recorded pid and lstart no longer match (R23)", () => {
		const p = legacyPopup();
		const { w, key } = p;
		p.set([`  900     1   900 ${LS} ${p.owner}`]);
		alertPass(w.deps);
		expect(w.kills).toEqual([[900, "SIGTERM"]]);
		plusSeconds(w, 31);
		p.set([`  900     1   900 ${LATER} /usr/bin/vim notes.txt`, `  905   900   900 ${LATER} /bin/sh -c make`]);
		alertPass(w.deps);
		expect(w.kills).toEqual([[900, "SIGTERM"]]);
		expect(w.rows()).toContain(`alert: ${key} legacy-popup settled cancelled at cutover`);
		expect(adopted(w, key)).toHaveLength(1);
	});
});
