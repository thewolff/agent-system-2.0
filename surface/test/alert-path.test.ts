// The alert path's core (PLAN wl-mw0vs9uc3xqtka D1, D3 records and legacy parses, D5; R8, R9, R13 at the decision level):
// the ladder's levels and timings, one episode per key, no second raise while an episode is open, a subject starting at 2
// sending levels 1 and 2 in one pass, ack and answer ending an episode, urgency's precedence, `stopIssueUrl`'s binding, and
// the legacy rows and markers cutover adoption reads. Every case runs on a temp ledger whose clock the test sets: the rows go
// through launch.ts's writers and `controlEntries`, and a recording pass applies `alertActions`' actions as rows, so what is
// asserted is what the next pass reads back.
import { describe, expect, test } from "bun:test";
import { type EntryRow, LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import {
	ALERT_LADDER, type AlertAction, alertActions, alertDigest, type AlertKeyRecord, alertLevel, alertPopupAnsweredAt, alertPopupRows, alertRecords, type AlertSeen, type AlertSubject,
	legacyMarkers, legacyTrainAlerts, legacyTrainLevel, openEpisode, stopIssueUrl, urgencyOf, withUrgency,
} from "../src/alert-path";
import { ensureStandingWorkload } from "../src/identity";
import { ALERT_BY, alertBody, alertPopupBody, type AlertRow, type ControlEntry, controlEntries, laneReleasedBody } from "../src/launch";
import { landFirstNoticeBody, landFirstRows, stopEpisode } from "../src/merge-train";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger } from "./helpers";

const T0 = "2026-11-03T10:52:00.000Z";
const WL = "wl-mw01xdcflkdnq0";
const ISSUES = "https://github.com/thewolff/jo-issues/issues";

function subject(over: Partial<AlertSubject> = {}): AlertSubject {
	return {
		key: `ceiling:${WL}`, kind: "ceiling", workloadId: WL, startLevel: 1, title: `${WL} stopped at its ceiling`,
		text: "ceiling $150 in force, spend $153.83", next: `extend ${WL}`, ...over,
	};
}

/** What a test drives: the ledger and its clock, a row writer as ALERT_BY, the alert rows read back, and the recording pass. */
interface World {
	c: { now: () => string; at: (iso: string) => void; plusHours: (h: number) => void };
	ledger: Ledger;
	write: (key: string, row: AlertRow) => string;
	control: () => ControlEntry[];
	records: () => Map<string, AlertKeyRecord>;
	pass: (subjects: AlertSubject[], seen?: AlertSeen) => AlertAction[];
	raisedRows: (key: string) => EntryRow[];
}

/** A ledger with the standing workload, a settable clock, and a recording pass that writes each action's rows as ALERT_BY. */
function world(): World {
	const c = clock(T0);
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	let issues = 0;
	const write = (key: string, row: AlertRow) => ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, row) });
	const control = () => controlEntries(ledger.entries(STANDING_WORKLOAD_ID));
	const records = () => alertRecords(control());
	const noSeen: AlertSeen = { issueStates: new Map(), acks: [] };
	/** One pass over `subjects`: the actions, each applied as the rows the real pass writes after its effects succeed. */
	const pass = (subjects: AlertSubject[], seen: AlertSeen = noSeen): AlertAction[] => {
		const actions = alertActions(subjects, records(), seen, c.now());
		for (const a of actions) {
			if (a.kind === "raise") write(a.subject.key, { row: "raised", kind: a.subject.kind, start: a.subject.startLevel, digest: a.digest });
			else if (a.kind === "send") {
				write(a.subject.key, { row: "level", level: a.level, step: "sending", url: null });
				write(a.subject.key, { row: "level", level: a.level, step: "sent", url: a.level === 1 ? `${ISSUES}/${++issues}` : null });
			} else if (a.kind === "update") write(a.subject.key, { row: "updated", digest: a.digest });
			else if (a.kind === "ack") write(a.subject.key, { row: "acked", why: a.why });
			else write(a.key, { row: "closed", why: a.why });
		}
		return actions;
	};
	const raisedRows = (key: string) => ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith(`alert: ${key} raised `));
	return { c, ledger, write, control, records, pass, raisedRows };
}

/** An action in a short form: `raise <key>`, `send <key> <level>`, `update <key>`, `ack <key> <by>`, `close <key>`. */
function shape(a: AlertAction): string {
	switch (a.kind) {
		case "raise": return `raise ${a.subject.key}`;
		case "send": return `send ${a.subject.key} ${a.level}`;
		case "update": return `update ${a.subject.key}`;
		case "ack": return `ack ${a.subject.key} ${a.by}`;
		case "close": return `close ${a.key}`;
	}
}

describe("the ladder (ALERT_LADDER): level 1 at raise, level 2 at 4 h, level 3 at 8 h, nothing after", () => {
	test("levels, labels and channels as D1 lists them, the popup last at each level", () => {
		expect(ALERT_LADDER.map((s) => [s.level, s.afterMs / 3_600_000, s.labels])).toEqual([[1, 0, []], [2, 4, ["loud"]], [3, 8, ["loud", "critical"]]]);
		for (const s of ALERT_LADDER) if (s.channels.includes("popup")) expect(s.channels.at(-1)).toBe("popup");
		expect(ALERT_LADDER[0]!.channels).toEqual(["line", "issue"]);
	});

	test("a level becomes due exactly at its time after level 1 was sent, never before, and level 3 is the last", () => {
		const w = world();
		const s = subject();
		expect(w.pass([s]).map(shape)).toEqual([`raise ${s.key}`, `send ${s.key} 1`]);
		w.c.at("2026-11-03T14:51:59.999Z");
		expect(w.pass([s])).toEqual([]);
		w.c.at("2026-11-03T14:52:00.000Z");
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 2`]);
		expect(alertLevel(w.records(), s.key)).toBe(2);
		w.c.at("2026-11-03T18:51:59.999Z");
		expect(w.pass([s])).toEqual([]);
		w.c.at("2026-11-03T18:52:00.000Z");
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 3`]);
		w.c.plusHours(48);
		expect(w.pass([s])).toEqual([]);
		expect(alertLevel(w.records(), s.key)).toBe(3);
	});

	test("a pass that slept past both times sends level 2 and level 3 in order in one pass", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		w.c.plusHours(9);
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 2`, `send ${s.key} 3`]);
	});

	test("a crash between `sending` and `sent` is finished first, and the ladder's clock runs from level 1's `sent`", () => {
		const w = world();
		const s = subject();
		w.write(s.key, { row: "raised", kind: "ceiling", start: 1, digest: alertDigest(s) });
		w.write(s.key, { row: "level", level: 1, step: "sending", url: null });
		w.c.plusHours(5);
		const owed = alertActions([s], w.records(), { issueStates: new Map(), acks: [] }, w.c.now());
		expect(owed.map(shape)).toEqual([`send ${s.key} 1`]);
		expect(owed[0]!.kind === "send" && owed[0]!.episode?.id).toBe(openEpisode(w.records().get(s.key))!.id);
		w.pass([s]);
		w.c.plusHours(3.99);
		expect(w.pass([s])).toEqual([]);
		w.c.plusHours(0.01);
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 2`]);
	});
});

describe("start level 2: level 1's silent channels and level 2 in the same pass", () => {
	test("a new subject starting at 2 gets raise, level 1, level 2, in that order, all on the episode the raise opens", () => {
		const w = world();
		const s = subject({ key: "move:en-abc", kind: "quota-move", workloadId: null, startLevel: 2 });
		const actions = w.pass([s]);
		expect(actions.map(shape)).toEqual([`raise ${s.key}`, `send ${s.key} 1`, `send ${s.key} 2`]);
		expect(actions.every((a) => a.kind !== "send" || a.episode === null)).toBe(true);
		expect(w.records().get(s.key)!.episodes).toHaveLength(1);
		// level 3 still counts from level 1's send
		w.c.plusHours(7.99);
		expect(w.pass([s])).toEqual([]);
		w.c.plusHours(0.01);
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 3`]);
	});

	test("a subject that becomes urgent while its episode is at level 1 gets level 2 at once, after one update for the new text", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		w.c.plusHours(1);
		const urgent = withUrgency(s, { urgent: true, from: "urgent in-x", unread: [] });
		expect(w.pass([urgent]).map(shape)).toEqual([`update ${s.key}`, `send ${s.key} 2`]);
		expect(w.pass([urgent])).toEqual([]);
	});
});

describe("coalescing: one episode per key, no second raise while it is open", () => {
	test("the same event every pass is one raise, one issue, one episode", () => {
		const w = world();
		const s = subject();
		for (let i = 0; i < 6; i++) {
			w.pass([s]);
			w.c.plusHours(0.25);
		}
		expect(w.raisedRows(s.key)).toHaveLength(1);
		expect(w.records().get(s.key)!.episodes).toHaveLength(1);
		expect(w.ledger.entries(STANDING_WORKLOAD_ID).filter((e) => e.body.startsWith(`alert: ${s.key} level 1 sent `))).toHaveLength(1);
	});

	test("two events on one workload are two keys: each closes on its own, the other stays open", () => {
		const w = world();
		const ceiling = subject();
		const parked = subject({ key: `parked:${WL}`, kind: "parked", title: `${WL} waits on q-mw0cxrzs3xrkz7`, next: "answer q-mw0cxrzs3xrkz7" });
		expect(w.pass([ceiling, parked]).map(shape)).toEqual([`raise ${ceiling.key}`, `send ${ceiling.key} 1`, `raise ${parked.key}`, `send ${parked.key} 1`]);
		const cleared = new Map([[ceiling.key, "Jo answered extend"]]);
		const actions = w.pass([parked], { issueStates: new Map(), acks: [], cleared });
		expect(actions.map(shape)).toEqual([`close ${ceiling.key}`]);
		expect(actions[0]!.kind === "close" && actions[0]!.why).toBe("Jo answered extend");
		expect(openEpisode(w.records().get(ceiling.key))).toBeNull();
		expect(openEpisode(w.records().get(parked.key))).not.toBeNull();
		expect(w.pass([parked])).toEqual([]);
	});

	test("a raise row written while an episode is open opens nothing: the reader keeps one episode", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		w.write(s.key, { row: "raised", kind: "ceiling", start: 1, digest: "ffffffffffff" });
		const rec = w.records().get(s.key)!;
		expect(rec.episodes).toHaveLength(1);
		expect(rec.loose.map((r) => r.row.row)).toEqual(["raised"]);
		expect(w.pass([s])).toEqual([]);
	});

	test("a changed text is one update once level 1 is sent, and the same text again is none", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		const changed = { ...s, text: "ceiling $150 in force, spend $160.10" };
		const actions = w.pass([changed]);
		expect(actions.map(shape)).toEqual([`update ${s.key}`]);
		expect(actions[0]!.kind === "update" && actions[0]!.digest).toBe(alertDigest(changed));
		expect(w.pass([changed])).toEqual([]);
		expect(w.pass([s]).map(shape)).toEqual([`update ${s.key}`]);
	});

	test("two subjects with one key throw, naming the key and both kinds", () => {
		const w = world();
		expect(() => alertActions([subject(), subject({ kind: "died" })], w.records(), { issueStates: new Map(), acks: [] }, T0)).toThrow(
			`alertActions: two subjects with key ceiling:${WL} (kinds ceiling and died)`,
		);
	});
});

describe("ack and close end an episode; nothing is sent after either", () => {
	test("Jo closes the issue at level 3: `ack` once, then nothing while the subject stays; when it clears, one close; when it returns, a new episode", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		w.c.plusHours(9);
		w.pass([s]);
		const ep = openEpisode(w.records().get(s.key))!;
		const closed: AlertSeen = { issueStates: new Map([[ep.id, "CLOSED"]]), acks: [] };
		const acked = w.pass([s], closed);
		expect(acked.map(shape)).toEqual([`ack ${s.key} issue`]);
		expect(acked[0]!.kind === "ack" && acked[0]!.why).toBe(`Jo closed ${ISSUES}/1`);
		w.c.plusHours(24);
		expect(w.pass([s], closed)).toEqual([]);
		expect(w.pass([{ ...s, text: "new facts" }], closed)).toEqual([]);
		expect(w.raisedRows(s.key)).toHaveLength(1);
		expect(w.pass([]).map(shape)).toEqual([`close ${s.key}`]);
		expect(w.pass([])).toEqual([]);
		expect(w.pass([s]).map(shape)).toEqual([`raise ${s.key}`, `send ${s.key} 1`]);
		expect(w.records().get(s.key)!.episodes).toHaveLength(2);
	});

	test("an open issue's state does not ack it", () => {
		const w = world();
		const s = subject();
		w.pass([s]);
		const ep = openEpisode(w.records().get(s.key))!;
		expect(w.pass([s], { issueStates: new Map([[ep.id, "OPEN"]]), acks: [] })).toEqual([]);
	});

	test("Jo's `ack <wl>` acks every open episode of that workload, `ack <key>` only that key, and an ack older than an episode does not ack it", () => {
		const w = world();
		const ceiling = subject();
		const parked = subject({ key: `parked:${WL}`, kind: "parked" });
		const other = subject({ key: "died:wl-other", kind: "died", workloadId: "wl-other" });
		w.pass([ceiling, parked, other]);
		w.c.plusHours(1);
		const byWorkload = w.pass([ceiling, parked, other], { issueStates: new Map(), acks: [{ target: WL, id: "in-ack1", at: w.c.now() }] });
		expect(byWorkload.map(shape)).toEqual([`ack ${ceiling.key} word`, `ack ${parked.key} word`]);
		expect(byWorkload[0]!.kind === "ack" && byWorkload[0]!.why).toBe(`Jo said ack ${WL} (in-ack1)`);
		const byKey = w.pass([ceiling, parked, other], { issueStates: new Map(), acks: [{ target: other.key, id: "in-ack2", at: w.c.now() }] });
		expect(byKey.map(shape)).toEqual([`ack ${other.key} word`]);
		// both end; the subject comes back: Jo's old ack does not ack the new episode
		w.pass([]);
		w.c.plusHours(1);
		const stale: AlertSeen = { issueStates: new Map(), acks: [{ target: WL, id: "in-ack1", at: "2026-11-03T11:52:00.000Z" }] };
		expect(w.pass([ceiling], stale).map(shape)).toEqual([`raise ${ceiling.key}`, `send ${ceiling.key} 1`]);
		expect(w.pass([ceiling], stale)).toEqual([]);
	});

	test("Jo's answer clears the subject: the episode closes once, with the issue the close names, and its level 1 begun with no url still closes", () => {
		const w = world();
		const s = subject({ key: "q:q-abc", kind: "train" });
		w.write(s.key, { row: "raised", kind: "train", start: 1, digest: alertDigest(s) });
		w.write(s.key, { row: "level", level: 1, step: "sending", url: null });
		const actions = w.pass([]);
		expect(actions.map(shape)).toEqual([`close ${s.key}`]);
		const ep = actions[0]!.kind === "close" ? actions[0]!.episode : null;
		expect(ep?.url).toBeNull();
		expect(ep?.sending.has(1)).toBe(true);
		expect(actions[0]!.kind === "close" && actions[0]!.why).toBe("q:q-abc is no longer active");
		expect(w.pass([])).toEqual([]);
	});
});

describe("the `alert:` records", () => {
	test("every row round-trips through alertBody, the ledger and controlEntries; another writer's copy is dropped", () => {
		const w = world();
		const rows: AlertRow[] = [
			{ row: "raised", kind: "main-red", start: 2, digest: "0123456789ab" },
			{ row: "level", level: 1, step: "sending", url: null },
			{ row: "level", level: 1, step: "sent", url: `${ISSUES}/7` },
			{ row: "updated", digest: "ba9876543210" },
			{ row: "error", channel: "gh", text: "gh issue comment exited 1: HTTP 502" },
			{ row: "merged", url: `${ISSUES}/3`, into: `${ISSUES}/7` },
			{ row: "merged-closed", url: `${ISSUES}/3` },
			{ row: "acked", why: "Jo closed the issue" },
			{ row: "closed", why: "stop-cleared on thewolff/agent-system-2.0" },
			{ row: "adopted", url: null, level: 0, from: "train-notice main-red https://github.com/thewolff/agent-system-2.0/issues/9" },
			{ row: "legacy-popup", text: "settled claim pid reused" },
		];
		const key = "main:thewolff/agent-system-2.0";
		for (const r of rows) w.write(key, r);
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, { row: "closed", why: "forged" }) });
		const rec = w.records().get(key)!;
		expect(rec.episodes).toHaveLength(2);
		const [first, second] = rec.episodes;
		expect(first).toMatchObject({ opened: "raised", kind: "main-red", start: 2, digest: "ba9876543210", url: `${ISSUES}/7`, acked: { why: "Jo closed the issue" } });
		expect(first!.closed?.why).toBe("stop-cleared on thewolff/agent-system-2.0");
		expect(first!.errors.get("gh")?.text).toBe("gh issue comment exited 1: HTTP 502");
		expect(first!.merged.get(`${ISSUES}/3`)).toMatchObject({ into: `${ISSUES}/7` });
		expect(first!.merged.get(`${ISSUES}/3`)!.closedAt).not.toBeNull();
		expect(second).toMatchObject({ opened: "adopted", url: null, adoptedFrom: rows[9]!.row === "adopted" ? rows[9]!.from : "", closed: null });
		expect(rec.loose.map((r) => r.row)).toEqual([rows[10]]);
	});

	test("an adopted level n counts levels 1..n as sent at adoption; level 0 files fresh", () => {
		const w = world();
		const s = subject({ key: "q:q-old", kind: "train" });
		w.write(s.key, { row: "adopted", url: `${ISSUES}/4`, level: 2, from: "train-alert q-old" });
		expect(alertLevel(w.records(), s.key)).toBe(2);
		expect(w.pass([s]).map(shape)).toEqual([`update ${s.key}`]);
		w.c.plusHours(8);
		expect(w.pass([s]).map(shape)).toEqual([`send ${s.key} 3`]);
		const fresh = subject({ key: "q:q-new", kind: "train" });
		w.write(fresh.key, { row: "adopted", url: null, level: 0, from: "train-alert q-new" });
		expect(w.pass([s, fresh]).map(shape)).toEqual([`send ${fresh.key} 1`]);
	});

	test("alertBody refuses a key or url that would not parse back", () => {
		expect(() => alertBody("ceiling: wl-x", { row: "acked", why: "x" })).toThrow('alertBody: key "ceiling: wl-x"');
		expect(() => alertBody("ceiling:wl-x", { row: "level", level: 1, step: "sent", url: "" })).toThrow("must be one non-empty token");
	});

	test("popup rows: parsed by key, episode and level; the newest `ok` is when Jo answered; another writer's row is dropped", () => {
		const w = world();
		const put = (body: string, by = ALERT_BY) => w.ledger.recordEntry({ by, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		put(alertPopupBody("move:en-a", "en-ep1", 2, "spawning"));
		put(alertPopupBody("move:en-a", "en-ep1", 2, "claim", "pid=41 pgid=41 attempt=1 until=2026-11-03T23:02:00.000Z"));
		w.c.plusHours(1);
		put(alertPopupBody("move:en-a", "en-ep1", 2, "ok", "Dismiss"));
		put(alertPopupBody("move:en-b", "en-ep2", 2, "ok", "Dismiss"), SURFACE_BY);
		const rows = alertPopupRows(w.control());
		expect(rows.map((r) => [r.key, r.episode, r.level, r.step, r.detail])).toEqual([
			["move:en-a", "en-ep1", 2, "spawning", ""],
			["move:en-a", "en-ep1", 2, "claim", "pid=41 pgid=41 attempt=1 until=2026-11-03T23:02:00.000Z"],
			["move:en-a", "en-ep1", 2, "ok", "Dismiss"],
		]);
		expect(alertPopupAnsweredAt(w.control(), "move:en-a")).toBe("2026-11-03T11:52:00.000Z");
		expect(alertPopupAnsweredAt(w.control(), "move:en-b")).toBeNull();
	});

	test("`lane-released:` counts only from the lane it names, while that lane is a holder", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "b", stakes: "normal", mode: "autonomous" });
		const lane = "lane-rel-1";
		expect(w.ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: lane, leaseMs: 600_000 }).won).toBe(true);
		w.ledger.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: laneReleasedBody(lane) });
		w.ledger.recordEntry({ by: "lane-other", workloadId: wl, kind: "assumption", body: laneReleasedBody(lane) });
		const control = controlEntries(w.ledger.entries(wl), [lane]);
		expect(control.filter((c) => c.prefix === "lane-released").map((c) => [c.laneId, c.createdBy])).toEqual([[lane, lane]]);
	});
});

describe("urgencyOf (D5): Jo's newest urgent / asap / calm word, else the cited input or the brief's quoted words", () => {
	const brief = 'Jo (input in-mw01ww9xf3gx8s; Jo ~6:05 PM PST 11/2: "yes and i want it done ASAP"): finish land-first.';
	/** A ledger holding Jo's input row on the standing workload and `words` on WL, in order; returns the rows urgencyOf reads. */
	function rows(words: { body: string; author?: string }[], input = "Open a workload: Jo wants it done ASAP") {
		const w = world();
		w.ledger.openWorkload({ by: SURFACE_BY, id: WL, brief, stakes: "normal", mode: "autonomous" });
		const inputId = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: input, author: "jo", channel: "surface" });
		for (const x of words) {
			w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: WL, body: x.body, author: x.author ?? "jo", channel: "surface" });
			w.c.plusHours(1);
		}
		const lookup = (ledger: Ledger) => (id: string) => ledger.instructions(STANDING_WORKLOAD_ID).find((i) => i.id === id) ?? null;
		return { w, inputId, instructions: w.ledger.instructions(WL), inputRow: lookup(w.ledger) };
	}

	test("the cited Jo input saying ASAP makes it urgent from that input's id (the 2:51 AM workload's case)", () => {
		const r = rows([]);
		const brief2 = brief.replace("in-mw01ww9xf3gx8s", r.inputId);
		expect(urgencyOf({ id: WL, brief: brief2 }, r.instructions, r.inputRow)).toEqual({ urgent: true, from: r.inputId, unread: [] });
	});

	test("with the cited input not ASAP, the brief's quoted words decide; with neither, not urgent", () => {
		const r = rows([], "Open a workload about land-first");
		const brief2 = brief.replace("in-mw01ww9xf3gx8s", r.inputId);
		expect(urgencyOf({ id: WL, brief: brief2 }, r.instructions, r.inputRow)).toEqual({ urgent: true, from: "brief quote", unread: [] });
		expect(urgencyOf({ id: WL, brief: brief2.replace("ASAP", "soon") }, r.instructions, r.inputRow)).toEqual({ urgent: false, from: null, unread: [] });
		// a curly-quoted urgent counts too; unquoted brief prose does not
		expect(urgencyOf({ id: WL, brief: "Jo said “this is urgent”" }, [], r.inputRow).urgent).toBe(true);
		expect(urgencyOf({ id: WL, brief: "an urgent-looking brief with no quote" }, [], r.inputRow).urgent).toBe(false);
	});

	test("a cited input that is missing is reported unread, never silently dropped", () => {
		const r = rows([], "nothing here");
		expect(urgencyOf({ id: WL, brief: "input in-nope0: do it" }, r.instructions, r.inputRow)).toEqual({ urgent: false, from: null, unread: ["in-nope0"] });
	});

	test("Jo's calm overrides the brief's ASAP; a later urgent or asap overrides calm; the newest word wins", () => {
		const calm = rows([{ body: `calm ${WL}` }]);
		const brief2 = brief.replace("in-mw01ww9xf3gx8s", calm.inputId);
		const c1 = urgencyOf({ id: WL, brief: brief2 }, calm.instructions, calm.inputRow);
		expect(c1.urgent).toBe(false);
		expect(c1.from).toBe(`calm ${calm.instructions[0]!.id}`);
		const back = rows([{ body: `calm ${WL}` }, { body: `asap ${WL}` }]);
		expect(urgencyOf({ id: WL, brief: "nothing" }, back.instructions, back.inputRow)).toMatchObject({ urgent: true, from: `asap ${back.instructions[1]!.id}` });
		const again = rows([{ body: `urgent ${WL}` }, { body: `calm ${WL}` }]);
		expect(urgencyOf({ id: WL, brief: brief2 }, again.instructions, again.inputRow).urgent).toBe(false);
	});

	test("a word naming another workload, or one not by Jo, is not a word on this workload", () => {
		const r = rows([{ body: "calm wl-other" }, { body: `calm ${WL}`, author: "lane-x" }]);
		const brief2 = brief.replace("in-mw01ww9xf3gx8s", r.inputId);
		expect(urgencyOf({ id: WL, brief: brief2 }, r.instructions, r.inputRow)).toEqual({ urgent: true, from: r.inputId, unread: [] });
	});

	test("withUrgency starts an urgent subject at 2 and names the source in its text; a calm one is unchanged", () => {
		const s = subject();
		expect(withUrgency(s, { urgent: true, from: "in-mw01ww9xf3gx8s", unread: [] })).toEqual({ ...s, startLevel: 2, text: `${s.text}\nurgent (from in-mw01ww9xf3gx8s)` });
		expect(withUrgency(s, { urgent: false, from: `calm in-x`, unread: [] })).toBe(s);
	});
});

describe("stopIssueUrl (D2.4): the issue a land-first stop's fix is named in", () => {
	const REPO = "thewolff/agent-system-2.0";
	const KEY = `main:${REPO}`;
	const TIP = "a".repeat(40);
	function stop(w: World, filed?: string) {
		const put = (body: string) => w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body });
		put(landFirstNoticeBody(REPO, { event: "stop-raised", kind: "regression", tip: TIP, g: null, suspects: [12], failing: 1 }));
		if (filed) put(landFirstNoticeBody(REPO, { event: "stop-filed", url: filed }));
		return stopEpisode(landFirstRows(w.ledger.entries(STANDING_WORKLOAD_ID), REPO))!;
	}
	const open = (w: World, n: number) => {
		w.write(KEY, { row: "raised", kind: "main-red", start: 1, digest: "0123456789ab" });
		w.write(KEY, { row: "level", level: 1, step: "sent", url: `${ISSUES}/${n}` });
	};

	test("a legacy episode's filed issue", () => {
		const w = world();
		expect(stopIssueUrl(w.ledger.entries(STANDING_WORKLOAD_ID), REPO, stop(w, `${ISSUES}/2`))).toBe(`${ISSUES}/2`);
	});

	test("the alert episode filed after the stop was raised", () => {
		const w = world();
		const ep = stop(w);
		w.c.plusHours(0.1);
		open(w, 5);
		expect(stopIssueUrl(w.ledger.entries(STANDING_WORKLOAD_ID), REPO, ep)).toBe(`${ISSUES}/5`);
	});

	test("an episode already open before the stop (from a main-red notice) is bound; one closed before the stop never is", () => {
		const w = world();
		open(w, 3);
		w.write(KEY, { row: "closed", why: "main-red cleared" });
		w.c.plusHours(1);
		const before = stop(w);
		expect(stopIssueUrl(w.ledger.entries(STANDING_WORKLOAD_ID), REPO, before)).toBeNull();
		const v = world();
		open(v, 6);
		v.c.plusHours(1);
		expect(stopIssueUrl(v.ledger.entries(STANDING_WORKLOAD_ID), REPO, stop(v))).toBe(`${ISSUES}/6`);
	});
});

describe("legacy alerts for adoption (D3)", () => {
	test("legacyTrainAlerts reads the retired ladder's rows (merge train's only): sent levels, the issue, the end", () => {
		const w = world();
		const train = w.ledger.openWorkload({ by: SURFACE_BY, brief: "train", stakes: "normal", mode: "autonomous" });
		const put = (body: string, by = MERGE_TRAIN_BY) => w.ledger.recordEntry({ by, workloadId: train, kind: "assumption", body });
		put("train-alert: q-aa level 1 sending");
		put(`train-alert: q-aa level 1 sent ${ISSUES}/8`);
		put("train-alert: q-aa level 2 sending");
		put("train-alert: q-aa level 2 notified");
		put("train-alert: q-bb level 1 sending");
		put(`train-alert: q-cc level 1 sent ${ISSUES}/9`);
		put("train-alert: q-cc acked Jo closed the issue");
		put("train-alert: q-cc closed forged", SURFACE_BY);
		const legacy = legacyTrainAlerts(controlEntries(w.ledger.entries(train)));
		expect([...legacy.get("q-aa")!.sent.keys()]).toEqual([1]);
		expect([...legacy.get("q-aa")!.sending.keys()]).toEqual([1, 2]);
		expect(legacy.get("q-aa")!.url).toBe(`${ISSUES}/8`);
		expect(legacy.get("q-bb")).toMatchObject({ url: null, end: null });
		expect(legacy.get("q-cc")!.end).toBe("acked");
	});

	test("legacyTrainLevel: a comment posted before a crash counts as sent; the body's level 1 marker counts with no row; nothing found is level 0", () => {
		const w = world();
		const train = w.ledger.openWorkload({ by: SURFACE_BY, brief: "train", stakes: "normal", mode: "autonomous" });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: `train-alert: q-aa level 1 sent ${ISSUES}/8` });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: "train-alert: q-aa level 2 sending" });
		const a = legacyTrainAlerts(controlEntries(w.ledger.entries(train))).get("q-aa");
		expect(legacyTrainLevel(a, "q-aa", null)).toBe(1);
		expect(legacyTrainLevel(a, "q-aa", { body: "<!-- train-alert q-aa level 1 -->", comments: ["@thewolff …\n<!-- train-alert q-aa level 2 -->", "<!-- train-alert q-zz level 3 -->"] })).toBe(2);
		expect(legacyTrainLevel(undefined, "q-bb", { body: "x\n<!-- train-alert q-bb level 1 -->", comments: [] })).toBe(1);
		expect(legacyTrainLevel(undefined, "q-bb", null)).toBe(0);
	});

	test("legacyMarkers finds each legacy alert's marker and no operational notice's", () => {
		const text = [
			"<!-- train-alert q-aa level 3 -->",
			"<!-- as2-quota-move en-m1 -->",
			"<!-- as2-quota-move-comment en-m1 -->",
			"<!-- train-notice land-first thewolff/agent-system-2.0 en-raised1 -->",
			"<!-- train-notice main-red https://github.com/thewolff/agent-system-2.0/issues/9 -->",
			`<!-- train-notice land-first thewolff/agent-system-2.0 promote-schema ${"b".repeat(40)} target none -->`,
			"<!-- train-notice protection thewolff/agent-system-2.0 en-p1 -->",
		].join("\n");
		expect(legacyMarkers(text)).toEqual([
			{ kind: "train-alert", q: "q-aa", level: 3 },
			{ kind: "quota-move", eventId: "en-m1" },
			{ kind: "quota-move-comment", eventId: "en-m1" },
			{ kind: "land-first", repo: "thewolff/agent-system-2.0", raised: "en-raised1" },
			{ kind: "main-red", url: "https://github.com/thewolff/agent-system-2.0/issues/9" },
		]);
	});
});
