// The quota-move alert (PLAN wl-mvwk0v0gmp6cjc D4; R6, R7): one @thewolff comment on one marked jo-issues issue per move, then
// a silent popup whose default and cancel is "Dismiss (no voice)", each channel claimed in the ledger, an ok channel never
// repeated, the popup run after a failed comment; stalled, dead and unstarted claims; three attempts per block and `--again`;
// and the state-derived failure line, on fire, delivered again on each new status and gone once both channels are ok.
// Temp ledgers on a settable clock, a fake gh (an in-memory jo-issues) and a fake popup only: no GitHub call, no real dialog.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_ENV, ROLE_ENV, WORKLOAD_ENV } from "../../gates/src/types";
import { LANE_RUNNER_BY, Ledger } from "../../ledger/src/index";
import { onFire } from "../src/batch";
import { consumeLines, Delivered } from "../src/delivery";
import { type ErrorLine, errorLines } from "../src/errors";
import type { Gh, GhResult } from "../src/jo-issues";
import { LANE_SCRIPT, laneHeadroomBody } from "../src/launch";
import { TRAIN_ALERT_LABEL, TRAIN_ALERT_REPO } from "../src/merge-train";
import {
	claimChannel, commentMarker, DISMISS_BUTTON, issueMarker, type MoveAlertSeams, moveAlertTroubles, osascriptPopup, type PopupResult, type QuotaMoveEvent, quotaMove,
	quotaMoveMessageId, quotaMoves, READ_IT_BUTTON, recordQuotaMove, runMoveAlert, settleChannel, spawnMoveAlert, superviseMove,
} from "../src/quota-move-alert";
import { SURFACE_BY } from "../src/types";
import { clock, type LaneRoot, laneRoot, sh, tempLedger, tmp } from "./helpers";

const A = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const LANE = "lane-qm-1";
const REASON = "anthropic 7d 0.95 used > 0.90";
const CANCELED: PopupResult = { code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" };

/** A ledger on a settable clock with one open workload. */
function world() {
	const c = clock("2026-11-02T10:00:00.000Z");
	const { ledger } = tempLedger(c.now);
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "quota move probe", stakes: "normal", mode: "autonomous" });
	const plusSeconds = (s: number) => c.at(new Date(Date.parse(c.now()) + s * 1000).toISOString());
	const move = (over: Partial<QuotaMoveEvent> = {}) => {
		const e: QuotaMoveEvent = { workloadId: wl, laneId: LANE, kind: "lane", from: A, to: SOL, reason: REASON, by: LANE_RUNNER_BY, eventBody: laneHeadroomBody(LANE, A, SOL, REASON), ...over };
		const id = recordQuotaMove(ledger, e);
		return quotaMove(ledger, id)!;
	};
	return { c, ledger, wl, plusSeconds, move };
}

interface FakeIssue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	comments: { body: string; url: string }[];
}

/** jo-issues in memory: the REST listing (one page), issue create / view / comment, label create. `fail` fails every call. */
function fakeGh(opts: { loseFirstCreateReply?: boolean } = {}) {
	const issues: FakeIssue[] = [];
	const calls: string[][] = [];
	const state = { fail: false, during: null as null | (() => void) };
	const url = (n: number) => `https://github.com/${TRAIN_ALERT_REPO}/issues/${n}`;
	const flag = (args: string[], f: string) => args[args.indexOf(f) + 1]!;
	const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });
	const gh: Gh = (args) => {
		calls.push(args);
		const during = state.during;
		state.during = null;
		during?.();
		if (state.fail) return { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway (https://api.github.com/graphql)" };
		if (args[0] === "api" && args[1] === `repos/${TRAIN_ALERT_REPO}/issues`) return ok(JSON.stringify([issues.map((i) => ({ body: i.body, html_url: url(i.number) }))]));
		if (args[0] === "issue" && args[1] === "create") {
			const n = issues.length + 1;
			issues.push({ number: n, title: flag(args, "--title"), body: flag(args, "--body"), labels: [flag(args, "--label")], comments: [] });
			if (opts.loseFirstCreateReply && n === 1) return { code: 1, stdout: "", stderr: "read: connection reset by peer" };
			return ok(`${url(n)}\n`);
		}
		const issue = issues[Number(args[2]) - 1];
		if (args[0] === "issue" && args[1] === "view" && issue) return ok(JSON.stringify({ comments: issue.comments }));
		if (args[0] === "issue" && args[1] === "comment" && issue) {
			const u = `${url(issue.number)}#issuecomment-${issue.comments.length + 1}`;
			issue.comments.push({ body: flag(args, "--body"), url: u });
			return ok(`${u}\n`);
		}
		if (args[0] === "label" && args[1] === "create") return ok("");
		return { code: 1, stdout: "", stderr: `fake gh: unexpected call ${args.join(" ")}` };
	};
	return { gh, issues, calls, state };
}

/** A worker's seams on fakes: `live` is the set of pids the probe calls alive; popups, voices, kills and log lines are recorded. */
function worker(gh: Gh, o: { pid?: number; live?: Set<number>; answer?: PopupResult; onPopup?: () => void } = {}) {
	const popups: { title: string; text: string }[] = [];
	const voiced: string[] = [];
	const kills: number[] = [];
	const logs: string[] = [];
	const live = o.live ?? new Set<number>();
	const seams: MoveAlertSeams = {
		gh,
		popup: (title, text) => {
			popups.push({ title, text });
			o.onPopup?.();
			return o.answer ?? CANCELED;
		},
		voice: (text) => {
			voiced.push(text);
			return null;
		},
		probe: (pid) => live.has(pid),
		kill: (pid) => {
			kills.push(pid);
		},
		pid: o.pid ?? 4242,
		log: (line) => logs.push(line),
	};
	return { seams, popups, voiced, kills, logs, live };
}

/** The move's `quota-move-alert:` rows, without their prefix and event id. */
const rows = (ledger: Ledger, wl: string, eventId: string) =>
	ledger.entries(wl, "assumption").filter((e) => e.created_by === LANE_RUNNER_BY && e.body.startsWith(`quota-move-alert: ${eventId} `)).map((e) => e.body.slice(`quota-move-alert: ${eventId} `.length));
const failureLines = (ledger: Ledger, live: Set<number> = new Set()): ErrorLine[] =>
	errorLines(ledger, undefined, { movePidProbe: (pid) => live.has(pid) }).filter((l) => l.kind === "quota-move-alert");
const textOf = (move: { workloadId: string }) => `lane ${LANE} on ${move.workloadId} moved ${A} -> ${SOL} (${REASON})`;

describe("the move record and its NOW line (R5)", () => {
	test("the event entry and the quota-move: message are one write: the NOW line is on fire, consumed on delivery, and a failed message write leaves no event", () => {
		const { ledger, wl, move } = world();
		const m = move();
		expect(ledger.entry(m.eventId)).toMatchObject({ created_by: LANE_RUNNER_BY, body: laneHeadroomBody(LANE, A, SOL, REASON) });
		expect(ledger.message(m.messageId)).toMatchObject({ recipient: "orchestrator", state: "held", body: `quota-move: lane ${LANE} on ${wl}: ${A} -> ${SOL} (${REASON})` });
		const now = errorLines(ledger, undefined, { movePidProbe: () => false }).filter((l) => l.kind === "quota-move");
		expect(now.map((l) => l.line)).toEqual([`NOW: ${textOf(m)}`]);
		expect(onFire(ledger, now[0]!)).toBe(true);
		consumeLines(ledger, now);
		expect(errorLines(ledger, undefined, { movePidProbe: () => false }).filter((l) => l.kind === "quota-move")).toEqual([]);
		// The message write fails: the event entry beside it is rolled back with it.
		const broken = Object.create(ledger) as Ledger;
		broken.enqueue = () => {
			throw new Error("disk I/O error");
		};
		const before = ledger.entries(wl).length;
		expect(() => recordQuotaMove(broken, { workloadId: wl, laneId: LANE, kind: "lane", from: A, to: SOL, reason: REASON, by: LANE_RUNNER_BY, eventBody: laneHeadroomBody(LANE, A, SOL, REASON) })).toThrow("disk I/O error");
		expect(ledger.entries(wl)).toHaveLength(before);
		expect(quotaMoves(ledger)).toHaveLength(1);
	});

	test("a hand move names its token and slice; an unclassified hand its key", () => {
		const { ledger, wl, move } = world();
		move({ kind: "hand", token: "tok-7", slice: "sl-a", by: LANE, eventBody: `hand-headroom: hand tok-7 (slice sl-a) of lane ${LANE} ${A} -> ${SOL} (${REASON})` });
		move({ kind: "hand", token: "key-3", by: LANE, eventBody: `hand-headroom: unclassified hand key-3 of lane ${LANE} ${A} -> ${SOL} (${REASON})` });
		expect(errorLines(ledger, undefined, { movePidProbe: () => false }).filter((l) => l.kind === "quota-move").map((l) => l.line)).toEqual([
			`NOW: hand tok-7 (slice sl-a) of lane ${LANE} on ${wl} moved ${A} -> ${SOL} (${REASON})`,
			`NOW: unclassified hand key-3 of lane ${LANE} on ${wl} moved ${A} -> ${SOL} (${REASON})`,
		]);
	});
});

describe("move-alert's channels (R6)", () => {
	test("one marked issue and one @thewolff comment per event, then one silent popup shown after `showing`; a second run repeats nothing", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		const newestAtPopup: string[] = [];
		const w = worker(g.gh, { onPopup: () => newestAtPopup.push(rows(ledger, wl, m.eventId).at(-1)!) });
		expect(runMoveAlert(ledger, w.seams, wl, m.eventId, false)).toBe(0);
		expect(g.issues).toHaveLength(1);
		const issue = g.issues[0]!;
		expect(issue.title).toBe("as2: lane moved off anthropic");
		expect(issue.labels).toEqual([TRAIN_ALERT_LABEL]);
		expect(issue.body).toContain(issueMarker(m.eventId));
		expect(issue.comments).toHaveLength(1);
		const comment = issue.comments[0]!.body;
		expect(comment).toStartWith("@thewolff ");
		for (const part of [`lane ${LANE}`, wl, A, SOL, REASON, commentMarker(m.eventId)]) expect(comment).toContain(part);
		expect(w.popups).toEqual([{ title: "as2: lane moved off anthropic", text: textOf(m) }]);
		expect(newestAtPopup).toEqual(["popup showing"]);
		expect(w.voiced).toEqual([]);
		expect(rows(ledger, wl, m.eventId)).toEqual([
			"comment claim pid=4242 attempt=1", `comment ok ${issue.comments[0]!.url}`, "popup claim pid=4242 attempt=1", "popup showing", `popup ok ${DISMISS_BUTTON}`,
		]);
		// Both channels are ok: a second worker makes no gh call and shows nothing.
		const calls = g.calls.length;
		expect(runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false)).toBe(0);
		expect(g.calls).toHaveLength(calls);
		expect(w.popups).toHaveLength(1);
		// Another event gets its own issue and comment.
		const m2 = move({ reason: "anthropic 7d projected 1.04" });
		expect(runMoveAlert(ledger, worker(g.gh).seams, wl, m2.eventId, false)).toBe(0);
		expect(g.issues.map((i) => i.comments.length)).toEqual([1, 1]);
		expect(g.issues[1]!.body).toContain(issueMarker(m2.eventId));
	});

	test("an issue create whose reply was lost is found by its marker: still one issue and one comment", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh({ loseFirstCreateReply: true });
		expect(runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false)).toBe(0);
		expect(g.issues).toHaveLength(1);
		expect(g.issues[0]!.comments).toHaveLength(1);
		expect(g.calls.filter((a) => a[0] === "issue" && a[1] === "create")).toHaveLength(1);
	});

	test("the popup still runs after a failed comment; only 'Read it to me' plays the voice", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		g.state.fail = true;
		const w = worker(g.gh, { answer: { code: 0, stdout: `${READ_IT_BUTTON}\n`, stderr: "" } });
		expect(runMoveAlert(ledger, w.seams, wl, m.eventId, false)).toBe(1);
		expect(rows(ledger, wl, m.eventId)).toEqual([
			"comment claim pid=4242 attempt=1", expect.stringMatching(/^comment failed gh api repos\/.+ exited 1: HTTP 502/), "popup claim pid=4242 attempt=1", "popup showing", `popup ok ${READ_IT_BUTTON}`,
		]);
		expect(w.popups).toHaveLength(1);
		expect(w.voiced).toEqual([textOf(m)]);
	});

	test("an empty or unexpected popup reply at exit 0 is a failed popup with its output kept, never a silent dismiss; the failure line shows it", () => {
		for (const stdout of ["", "OK\n"]) {
			const { ledger, wl, move } = world();
			const m = move();
			const w = worker(fakeGh().gh, { answer: { code: 0, stdout, stderr: "" } });
			expect(runMoveAlert(ledger, w.seams, wl, m.eventId, false)).toBe(1);
			const popupRows = rows(ledger, wl, m.eventId).filter((r) => r.startsWith("popup "));
			expect(popupRows.at(-1)).toBe(`popup failed osascript exit 0 with no button: stdout ${JSON.stringify(stdout.trim())}, stderr ""`);
			expect(popupRows.some((r) => r.startsWith("popup ok"))).toBe(false);
			expect(w.voiced).toEqual([]);
			expect(failureLines(ledger).map((l) => l.line).join("\n")).toContain("popup failed osascript exit 0 with no button");
		}
	});

	test("the dialog is osascript's display dialog with the two buttons, Dismiss the default and the cancel, and no giving up", () => {
		const dir = tmp("osascript");
		const argsFile = join(dir, "args");
		const bin = join(dir, "osascript");
		writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argsFile}'\nprintf '%s\\n' '${DISMISS_BUTTON}'\n`);
		chmodSync(bin, 0o755);
		expect(osascriptPopup(bin)("as2: lane moved off anthropic", "the text")).toEqual({ code: 0, stdout: `${DISMISS_BUTTON}\n`, stderr: "" });
		const argv = readFileSync(argsFile, "utf8");
		expect(argv).toContain(`display dialog (item 2 of argv) with title (item 1 of argv) buttons {"${READ_IT_BUTTON}", "${DISMISS_BUTTON}"} default button "${DISMISS_BUTTON}" cancel button "${DISMISS_BUTTON}"\n`);
		expect(argv).not.toContain("giving up");
		expect(argv).not.toContain("sound");
		expect(argv.trimEnd().split("\n").slice(-2)).toEqual(["as2: lane moved off anthropic", "the text"]);
	});

	test("two workers never run one channel, and the popup waits for the comment's result: B, started during A's comment, shows nothing; A shows the popup after its comment result", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		const live = new Set([101, 202]);
		const b = worker(g.gh, { pid: 202, live });
		let bExit: number | null = null;
		// Worker B starts while A waits on its first gh call.
		g.state.during = () => {
			bExit = runMoveAlert(ledger, b.seams, wl, m.eventId, false);
		};
		const atPopup: string[][] = [];
		const a = worker(g.gh, { pid: 101, live, onPopup: () => atPopup.push(rows(ledger, wl, m.eventId)) });
		expect(runMoveAlert(ledger, a.seams, wl, m.eventId, false)).toBe(0);
		expect(bExit).toBe(0);
		expect(b.logs).toEqual([
			`move-alert ${m.eventId}: comment not run: running (pid 101, attempt 1)`,
			`move-alert ${m.eventId}: popup not run: the comment has no result yet (comment running (pid 101, attempt 1)): the popup follows it, so it is left to the worker that runs the comment, or to the train tick`,
		]);
		expect([a.popups.length, b.popups.length]).toEqual([1, 0]);
		expect(g.issues.map((i) => i.comments.length)).toEqual([1]);
		const url = g.issues[0]!.comments[0]!.url;
		// A's dialog came up after its comment result and its own popup claim; B claimed nothing.
		expect(atPopup).toEqual([["comment claim pid=101 attempt=1", `comment ok ${url}`, "popup claim pid=101 attempt=1", "popup showing"]]);
		expect(rows(ledger, wl, m.eventId)).toEqual(["comment claim pid=101 attempt=1", `comment ok ${url}`, "popup claim pid=101 attempt=1", "popup showing", `popup ok ${DISMISS_BUTTON}`]);
	});

	test("a comment worker that died leaves the popup to the train tick: its claim is settled failed, the respawned worker retries the comment, then shows the popup", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		// Worker 500 claimed the comment and ended with no result; a second worker finds the popup not yet eligible only while 500 lives.
		const live = new Set([500]);
		expect(claimChannel(ledger, m, "comment", worker(g.gh, { pid: 500, live }).seams)).toMatchObject({ attempt: 1 });
		expect(claimChannel(ledger, m, "popup", worker(g.gh, { pid: 501, live }).seams)).toEqual({
			refused: "the comment has no result yet (comment running (pid 500, attempt 1)): the popup follows it, so it is left to the worker that runs the comment, or to the train tick",
		});
		live.delete(500);
		const spawned: string[][] = [];
		const tick = worker(g.gh, { pid: 600 });
		const lines = superviseMove(ledger, m, { ...tick.seams, spawn: (argv) => (spawned.push(argv), 700) });
		expect(lines).toEqual([`quota-move-alert: ${m.eventId} comment failed worker 500 ended without a result`, "move-alert spawned for comment: pid 700"]);
		expect(spawned).toHaveLength(1);
		// The spawned worker: the comment's second attempt, then the popup after its result.
		const respawned = worker(g.gh, { pid: 700, live: new Set([700]) });
		expect(runMoveAlert(ledger, respawned.seams, wl, m.eventId, false)).toBe(0);
		expect(respawned.popups).toHaveLength(1);
		expect(rows(ledger, wl, m.eventId)).toEqual([
			"comment claim pid=500 attempt=1", "comment failed worker 500 ended without a result", "comment spawning", "popup spawning",
			"comment claim pid=700 attempt=2", `comment ok ${g.issues[0]!.comments[0]!.url}`, "popup claim pid=700 attempt=1", "popup showing", `popup ok ${DISMISS_BUTTON}`,
		]);
	});
});

describe("claims, deadlines and the failure line (R7)", () => {
	test("a comment claim past 180 s and a popup claim with no showing past 30 s are stalled: SIGTERM, then failed stalled; a popup claim settles a stalled comment first", () => {
		const { ledger, wl, move, plusSeconds } = world();
		const m = move();
		const live = new Set([300]);
		const w = worker(fakeGh().gh, { pid: 300, live });
		expect(claimChannel(ledger, m, "comment", w.seams)).toMatchObject({ attempt: 1 });
		plusSeconds(179);
		expect(settleChannel(ledger, m, "comment", w.seams, true)).toBeNull();
		expect(failureLines(ledger, live)).toEqual([]);
		plusSeconds(2);
		expect(settleChannel(ledger, m, "comment", w.seams, true)).toBe(`quota-move-alert: ${m.eventId} comment failed stalled: no comment result after 181 s (pid 300)`);
		expect(w.kills).toEqual([300]);
		// m2's comment worker 302 is alive but past its deadline: the popup claim settles it (SIGTERM, failed stalled), then claims.
		const m2 = move();
		const p = worker(fakeGh().gh, { pid: 301, live: new Set([301, 302]) });
		expect(claimChannel(ledger, m2, "comment", { ...p.seams, pid: 302 })).toMatchObject({ attempt: 1 });
		plusSeconds(181);
		expect(claimChannel(ledger, m2, "popup", p.seams)).toMatchObject({ attempt: 1 });
		expect(p.kills).toEqual([302]);
		plusSeconds(31);
		expect(settleChannel(ledger, m2, "popup", p.seams, false)).toBe(`quota-move-alert: ${m2.eventId} popup failed stalled: no showing after 31 s (pid 301)`);
		expect(p.kills).toEqual([302, 301]);
		expect(rows(ledger, wl, m2.eventId)).toEqual([
			"comment claim pid=302 attempt=1", "comment failed stalled: no comment result after 181 s (pid 302)", "popup claim pid=301 attempt=1",
			"popup failed stalled: no showing after 31 s (pid 301)",
		]);
	});

	test("a popup showing with a live pid waits on Jo with no deadline and no failure line", () => {
		const { ledger, wl, move, c } = world();
		const m = move();
		const live = new Set([4242]);
		const seen: ErrorLine[][] = [];
		const w = worker(fakeGh().gh, {
			live,
			onPopup: () => {
				c.plusHours(5);
				seen.push(failureLines(ledger, live));
			},
		});
		expect(runMoveAlert(ledger, w.seams, wl, m.eventId, false)).toBe(0);
		expect(seen).toEqual([[]]);
	});

	test("a dead claim and an unstarted move both surface on the failure line", () => {
		const { ledger, wl, move, plusSeconds } = world();
		const dead = move();
		claimChannel(ledger, dead, "comment", worker(fakeGh().gh, { pid: 400 }).seams);
		const quiet = move();
		plusSeconds(59);
		expect(failureLines(ledger).map((l) => [l.rowId, l.line])).toEqual([
			[dead.eventId, `NOW: alert for the move of lane ${LANE} on ${wl} (${A} -> ${SOL}): comment dead: worker 400 ended without a result — the train tick retries (attempt 1 of 3)`],
		]);
		plusSeconds(2);
		const lines = failureLines(ledger);
		expect(lines.map((l) => l.rowId)).toEqual([dead.eventId, quiet.eventId]);
		expect(lines[1]!.line).toBe(`NOW: alert for the move of lane ${LANE} on ${wl} (${A} -> ${SOL}): comment unstarted: no claim 61 s after the move; popup unstarted: no claim 61 s after the move — the train tick retries (attempt 0 of 3)`);
		for (const l of lines) expect(onFire(ledger, l)).toBe(true);
	});

	test("a channel is exhausted after 3 failed attempts; --again opens a new block of 3", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		g.state.fail = true;
		for (let i = 0; i < 3; i++) expect(runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false)).toBe(1);
		expect(rows(ledger, wl, m.eventId).filter((r) => r.startsWith("comment claim"))).toEqual(["comment claim pid=4242 attempt=1", "comment claim pid=4242 attempt=2", "comment claim pid=4242 attempt=3"]);
		const [line] = failureLines(ledger);
		expect(line!.line).toContain("comment exhausted after 3 attempts, last failed gh api");
		expect(line!.line).toEndWith(`— run bun surface/scripts/lane.ts move-alert ${wl} ${m.eventId} --again`);
		// A fourth worker runs nothing; the supervisor spawns none.
		const calls = g.calls.length;
		const fourth = worker(g.gh);
		expect(runMoveAlert(ledger, fourth.seams, wl, m.eventId, false)).toBe(1);
		expect(fourth.logs.some((l) => l.includes("comment not run: exhausted after 3 attempts"))).toBe(true);
		expect(g.calls).toHaveLength(calls);
		const spawned: string[][] = [];
		expect(superviseMove(ledger, m, { ...fourth.seams, spawn: (argv) => (spawned.push(argv), 1) })).toEqual([]);
		expect(spawned).toEqual([]);
		// By hand, with gh back: a new block, attempt 1 again, and the comment lands.
		g.state.fail = false;
		const again = worker(g.gh);
		expect(runMoveAlert(ledger, again.seams, wl, m.eventId, true)).toBe(0);
		expect(rows(ledger, wl, m.eventId).slice(-3)).toEqual(["comment again by hand after 3 attempts", "comment claim pid=4242 attempt=1", expect.stringMatching(/^comment ok https:/)]);
		expect(failureLines(ledger)).toEqual([]);
	});

	test("the failure line is delivered again on each new status and clears when both channels are ok", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const g = fakeGh();
		g.state.fail = true;
		const delivered = new Delivered();
		runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false);
		const first = delivered.take(failureLines(ledger));
		expect(first.map((l) => [l.kind, l.rowId])).toEqual([["quota-move-alert", m.eventId]]);
		expect(first[0]!.line).toContain("comment failed gh api");
		expect(first[0]!.line).toEndWith("— the train tick retries (attempt 1 of 3)");
		expect(delivered.take(failureLines(ledger))).toEqual([]);
		runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false);
		const second = delivered.take(failureLines(ledger));
		expect(second).toHaveLength(1);
		expect(second[0]!.state).not.toBe(first[0]!.state);
		expect(second[0]!.line).toEndWith("(attempt 2 of 3)");
		g.state.fail = false;
		runMoveAlert(ledger, worker(g.gh).seams, wl, m.eventId, false);
		expect(failureLines(ledger)).toEqual([]);
		expect(moveAlertTroubles(ledger, Date.parse(ledger.now()), () => false)).toEqual([]);
	});

	test("spawnMoveAlert starts lane.ts move-alert without the lane binding; a spawn failure is written unstarted and shows", () => {
		const { ledger, wl, move } = world();
		const m = move();
		const saved = { [ROLE_ENV]: process.env[ROLE_ENV], [WORKLOAD_ENV]: process.env[WORKLOAD_ENV], [LANE_ENV]: process.env[LANE_ENV] };
		Object.assign(process.env, { [ROLE_ENV]: "lane", [WORKLOAD_ENV]: wl, [LANE_ENV]: LANE });
		try {
			const seen: { argv: string[]; env: Record<string, string>; log: string }[] = [];
			expect(spawnMoveAlert(ledger, wl, m.eventId, (argv, env, log) => (seen.push({ argv, env, log }), 777), () => false)).toBe(777);
			expect(seen[0]!.argv.slice(1)).toEqual([LANE_SCRIPT, "move-alert", wl, m.eventId]);
			expect([ROLE_ENV, WORKLOAD_ENV, LANE_ENV].filter((k) => k in seen[0]!.env)).toEqual([]);
			expect(seen[0]!.log).toEndWith(join(wl, "move-alert.log"));
			expect(rows(ledger, wl, m.eventId)).toEqual(["comment spawning", "popup spawning"]);
			expect(spawnMoveAlert(ledger, wl, m.eventId, () => {
				throw new Error("posix_spawn: EAGAIN");
			}, () => false)).toBeNull();
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
		expect(rows(ledger, wl, m.eventId).slice(2)).toEqual([
			"comment spawning", "popup spawning", "comment unstarted spawn: posix_spawn: EAGAIN", "popup unstarted spawn: posix_spawn: EAGAIN",
		]);
		expect(failureLines(ledger).map((l) => l.line)).toEqual([
			`NOW: alert for the move of lane ${LANE} on ${wl} (${A} -> ${SOL}): comment unstarted spawn: posix_spawn: EAGAIN; popup unstarted spawn: posix_spawn: EAGAIN — the train tick retries (attempt 1 of 3)`,
		]);
		expect(quotaMoveMessageId(m.eventId)).toBe(m.messageId);
	});
});

describe("the lane.ts move-alert subcommand", () => {
	const roots: LaneRoot[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r.root, { recursive: true, force: true });
	});

	test("runs both channels on AS2_MOVE_ALERT_GH and AS2_MOVE_ALERT_OSASCRIPT; a second run repeats only the failed comment", () => {
		const r = laneRoot();
		roots.push(r);
		const gh = join(r.root, "fake-gh");
		writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(r.root, "gh.log")}'\necho 'fake gh: offline' >&2\nexit 1\n`);
		const osa = join(r.root, "fake-osascript");
		writeFileSync(osa, `#!/bin/sh\necho popup >> '${join(r.root, "popup.log")}'\necho '${DISMISS_BUTTON}'\n`);
		chmodSync(gh, 0o755);
		chmodSync(osa, 0o755);
		const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		let wl: string;
		let e: string;
		try {
			wl = l.openWorkload({ by: SURFACE_BY, brief: "move-alert subcommand probe", stakes: "normal", mode: "autonomous" });
			e = recordQuotaMove(l, { workloadId: wl, laneId: LANE, kind: "lane", from: A, to: SOL, reason: REASON, by: LANE_RUNNER_BY, eventBody: laneHeadroomBody(LANE, A, SOL, REASON) });
		} finally {
			l.close();
		}
		const env = { ...r.env, AS2_MOVE_ALERT_GH: gh, AS2_MOVE_ALERT_OSASCRIPT: osa };
		const first = sh(["bun", LANE_SCRIPT, "move-alert", wl, e], r.repo, env);
		expect(first.code).toBe(1);
		expect(first.err).toContain(`move-alert ${e}: comment failed gh api repos/${TRAIN_ALERT_REPO}/issues --method exited 1: fake gh: offline`);
		expect(first.err).toContain(`move-alert ${e}: popup ok ${DISMISS_BUTTON}`);
		expect(sh(["bun", LANE_SCRIPT, "move-alert", wl, e], r.repo, env).code).toBe(1);
		expect(readFileSync(join(r.root, "popup.log"), "utf8")).toBe("popup\n");
		expect(readFileSync(join(r.root, "gh.log"), "utf8").trim().split("\n")).toHaveLength(2);
		const after = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
		try {
			expect(rows(after, wl, e)).toEqual([
				expect.stringMatching(/^comment claim pid=\d+ attempt=1$/), expect.stringMatching(/^comment failed /), expect.stringMatching(/^popup claim /), "popup showing",
				`popup ok ${DISMISS_BUTTON}`, expect.stringMatching(/^comment claim pid=\d+ attempt=2$/), expect.stringMatching(/^comment failed /),
			]);
		} finally {
			after.close();
		}
	}, 60_000);
});
