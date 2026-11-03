// The quota move (PLAN wl-mvwk0v0gmp6cjc D4; R5, R6, R7) on the one alert path (PLAN wl-mw0vs9uc3xqtka D2.8, D3): the move
// record and its NOW line, then the alert pass's `move:<E>` key, which files one marked jo-issues issue per move with one
// @thewolff comment and one silent popup at level 2, finds a lost create by its marker, and shows a failed send on the ALERT
// line until the next pass files it. The retired move-alert worker (claims, deadlines, `lane.ts move-alert`) has no cases: its
// popup and settlement are alert-popup.test.ts's and alert-pass.test.ts's, its legacy rows alert-cutover.test.ts's.
// Temp ledgers on a settable clock and the recording seams of alert-world.ts only: no GitHub call, no real dialog.
import { describe, expect, test } from "bun:test";
import { LANE_RUNNER_BY, type Ledger } from "../../ledger/src/index";
import { alertPass } from "../scripts/alert-tick";
import { onFire } from "../src/batch";
import { consumeLines, Delivered } from "../src/delivery";
import { errorLines } from "../src/errors";
import { laneHeadroomBody } from "../src/launch";
import { TRAIN_ALERT_LABEL } from "../src/merge-train";
import { type QuotaMoveEvent, quotaMove, quotaMoveMessageId, quotaMoves, recordQuotaMove } from "../src/quota-move-alert";
import { SURFACE_BY } from "../src/types";
import { type AlertWorld, world as alertWorld } from "./alert-world";
import { clock, tempLedger } from "./helpers";

const A = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const LANE = "lane-qm-1";
const REASON = "anthropic 7d 0.95 used > 0.90";

/** A ledger on a settable clock with one open workload; `given` (an alert world's ledger) is used instead when passed. */
function world(given?: Ledger) {
	const ledger = given ?? tempLedger(clock("2026-11-02T10:00:00.000Z").now).ledger;
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "quota move probe", stakes: "normal", mode: "autonomous" });
	const move = (over: Partial<QuotaMoveEvent> = {}) => {
		const e: QuotaMoveEvent = { workloadId: wl, laneId: LANE, kind: "lane", from: A, to: SOL, reason: REASON, by: LANE_RUNNER_BY, eventBody: laneHeadroomBody(LANE, A, SOL, REASON), ...over };
		const id = recordQuotaMove(ledger, e);
		return quotaMove(ledger, id)!;
	};
	return { ledger, wl, move };
}

const textOf = (move: { workloadId: string }) => `lane ${LANE} on ${move.workloadId} moved ${A} -> ${SOL} (${REASON})`;

describe("the move record and its NOW line (R5)", () => {
	test("the event entry and the quota-move: message are one write: the NOW line is on fire, consumed on delivery, and a failed message write leaves no event", () => {
		const { ledger, wl, move } = world();
		const m = move();
		expect(ledger.entry(m.eventId)).toMatchObject({ created_by: LANE_RUNNER_BY, body: laneHeadroomBody(LANE, A, SOL, REASON) });
		expect(ledger.message(m.messageId)).toMatchObject({ recipient: "orchestrator", state: "held", body: `quota-move: lane ${LANE} on ${wl}: ${A} -> ${SOL} (${REASON})` });
		const now = errorLines(ledger).filter((l) => l.kind === "quota-move");
		expect(now.map((l) => l.line)).toEqual([`NOW: ${textOf(m)}`]);
		expect(onFire(ledger, now[0]!)).toBe(true);
		consumeLines(ledger, now);
		expect(errorLines(ledger).filter((l) => l.kind === "quota-move")).toEqual([]);
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
		expect(errorLines(ledger).filter((l) => l.kind === "quota-move").map((l) => l.line)).toEqual([
			`NOW: hand tok-7 (slice sl-a) of lane ${LANE} on ${wl} moved ${A} -> ${SOL} (${REASON})`,
			`NOW: unclassified hand key-3 of lane ${LANE} on ${wl} moved ${A} -> ${SOL} (${REASON})`,
		]);
	});
});

describe("the alert pass's move:<E> key (R6, R7 on PLAN wl-mw0vs9uc3xqtka D2.8, D3)", () => {
	/** An alert world (standing workload, recording gh and popup seams) with one open workload and its moves. */
	const moved = (o: { fail?: (args: string[]) => boolean } = {}) => {
		const a = alertWorld(o);
		return { a, ...world(a.ledger) };
	};
	const creates = (a: AlertWorld) => a.g.calls.filter((c) => c[0] === "issue" && c[1] === "create");

	test("one marked issue and one @thewolff comment per move, then one silent popup at level 2; a second pass repeats nothing; another move gets its own issue", () => {
		const { a, move } = moved();
		const m = move();
		const key = `move:${m.eventId}`;
		expect(alertPass(a.deps).problems).toEqual([]);
		expect(a.g.issues).toHaveLength(1);
		const issue = a.g.issues[0]!;
		expect(issue.title).toBe("as2: lane moved off anthropic");
		expect(issue.labels[0]).toBe(TRAIN_ALERT_LABEL);
		expect(issue.labels).toContain("loud");
		expect(issue.body).toContain(`<!-- as2-alert ${key} `);
		expect(issue.body).toContain(textOf(m));
		expect(issue.comments).toHaveLength(1);
		expect(issue.comments[0]).toContain("\n@thewolff needs you now: as2: lane moved off anthropic.");
		expect(a.spawns.map((s) => [s.argv[2], s.argv[4]])).toEqual([[key, "2"]]);
		// Level 2 is sent: a second pass makes no create, no comment and no popup.
		alertPass(a.deps);
		expect(creates(a)).toHaveLength(1);
		expect(issue.comments).toHaveLength(1);
		expect(a.spawns).toHaveLength(1);
		// Another move gets its own key, issue and comment.
		const m2 = move({ reason: "anthropic 7d projected 1.04" });
		alertPass(a.deps);
		expect(a.g.issues.map((i) => i.comments.length)).toEqual([1, 1]);
		expect(a.g.issues[1]!.body).toContain(`<!-- as2-alert move:${m2.eventId} `);
		expect(quotaMoveMessageId(m.eventId)).toBe(m.messageId);
	});

	test("an issue create whose reply was lost is found by its marker on the next pass: still one issue and one comment", () => {
		const { a, move } = moved();
		const m = move();
		let lost = 0;
		const gh = a.deps.gh;
		const deps = {
			...a.deps,
			gh: (args: string[]) => {
				const r = gh(args);
				return args[0] === "issue" && args[1] === "create" && lost++ === 0 ? { code: 1, stdout: "", stderr: "read: connection reset by peer" } : r;
			},
		};
		alertPass(deps);
		alertPass(deps);
		expect(a.g.issues).toHaveLength(1);
		expect(a.g.issues[0]!.comments).toHaveLength(1);
		expect(creates(a)).toHaveLength(1);
		expect(a.rows()).toContainEqual(`alert: move:${m.eventId} level 1 sent ${a.g.issues[0]!.url}`);
	});

	test("a failed send is on the ALERT line, on fire and delivered once; the line names the issue, delivered again, once the next pass files it", () => {
		const failing = { on: true };
		const { a, move } = moved({ fail: () => failing.on });
		const m = move();
		const alertLines = () => errorLines(a.ledger).filter((l) => l.kind === "alert");
		const delivered = new Delivered();
		alertPass(a.deps);
		const first = delivered.take(alertLines());
		expect(first).toHaveLength(1);
		// nothing is sent yet, so no level's LOUD tag
		expect(first[0]!.line).toStartWith("ALERT as2: lane moved off anthropic: ");
		expect(first[0]!.line).toContain("issue not filed: ");
		expect(first[0]!.line).toContain("HTTP 502: Bad Gateway");
		expect(onFire(a.ledger, first[0]!)).toBe(true);
		expect(delivered.take(alertLines())).toEqual([]);
		failing.on = false;
		alertPass(a.deps);
		const after = alertLines();
		expect(after).toHaveLength(1);
		expect(after[0]!.line).toStartWith("ALERT LOUD as2: lane moved off anthropic: ");
		expect(after[0]!.line).toContain(`issue ${a.g.issues[0]!.url}`);
		expect(after[0]!.line).not.toContain("issue not filed");
		expect(delivered.take(after)).toHaveLength(1);
		expect(quotaMoves(a.ledger).map((q) => q.eventId)).toEqual([m.eventId]);
	});
});
