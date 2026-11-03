// The ALERT needs-you lines (PLAN wl-mw0vs9uc3xqtka D4): one per open episode of the alert path Jo has not acked, read
// from ALERT_BY's `alert:` and `alert-popup:` rows on the standing workload, first of all the lines, on fire, delivered
// again at each new level or failure, gone once the episode is acked or closed. A train question's LOUD tag stays on
// its own line beside the ALERT line, which carries the issue and the popup.
import { describe, expect, test } from "bun:test";
import { ALERT_POPUP_ATTEMPTS, alertWords, type AlertSubject } from "../src/alert-path";
import { onFire } from "../src/batch";
import { Delivered } from "../src/delivery";
import { type ErrorLine, errorLines } from "../src/errors";
import { ensureStandingWorkload } from "../src/identity";
import { ALERT_BY, type AlertPopupStep, type AlertRow, alertBody, alertPopupBody } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { clock, tempLedger, workloadWithSlice } from "./helpers";

const ISSUE = "https://github.com/thewolff/jo-issues/issues/7";

function world() {
	const c = clock("2026-11-03T10:00:00.000Z");
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const { wl } = workloadWithSlice(ledger);
	const write = (key: string, row: AlertRow): string =>
		ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(key, row) });
	const popup = (key: string, episode: string, level: number, step: AlertPopupStep, detail?: string): string =>
		ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(key, episode, level, step, detail) });
	const subject: Pick<AlertSubject, "title" | "text" | "next" | "workloadId"> = {
		title: `${wl} stopped at its ceiling`, text: "spent $153.83 of $150\nlane-4 exited", next: `extend ${wl}`, workloadId: wl,
	};
	const key = `ceiling:${wl}`;
	/** The episode raised with its words, level 1 sent with its issue; returns the episode id. */
	const raise = (start: 1 | 2 = 1): string => {
		const ep = write(key, { row: "raised", kind: "ceiling", start, digest: "0123456789ab", words: alertWords(subject) });
		write(key, { row: "level", level: start, step: "sending", url: null });
		write(key, { row: "level", level: start, step: "sent", url: start === 1 ? ISSUE : null });
		return ep;
	};
	const send = (level: number) => {
		write(key, { row: "level", level, step: "sending", url: null });
		write(key, { row: "level", level, step: "sent", url: null });
	};
	const alerts = (): ErrorLine[] => errorLines(ledger).filter((l) => l.kind === "alert");
	return { c, ledger, wl, write, popup, subject, key, raise, send, alerts };
}

describe("ALERT lines (D4)", () => {
	test("an open episode is one line in D4's shape, the first line of all, on fire, its next step the subject's", () => {
		const w = world();
		// a question on the workload, so there is another line for the ALERT line to come before
		const sl = w.ledger.addSlice({ by: "lane-a", workloadId: w.wl, task: "ask", doneCondition: "answered", inputs: "none" });
		w.ledger.raiseQuestion({ by: "lane-a", workloadId: w.wl, sliceId: sl, body: "which way?", options: ["left", "right"] });
		const ep = w.raise();
		const all = errorLines(w.ledger);
		expect(all.length).toBeGreaterThan(1);
		expect(all[0]).toMatchObject({
			kind: "alert", workloadId: w.wl, rowId: ep, state: "L1", next: `extend ${w.wl}`,
			line: `ALERT ${w.wl} stopped at its ceiling: spent $153.83 of $150 — extend ${w.wl} (issue ${ISSUE}; popup not yet)`,
		});
		expect(onFire(w.ledger, all[0]!)).toBe(true);
	});

	test("level 2 is LOUD and level 3 CRITICAL; each level is a new state, so delivery pushes the line again; the same state is not re-pushed", () => {
		const w = world();
		w.raise();
		const d = new Delivered();
		expect(d.take(w.alerts())).toHaveLength(1);
		expect(d.take(w.alerts())).toHaveLength(0);
		w.send(2);
		const loud = w.alerts();
		expect(loud[0]!.line).toStartWith(`ALERT LOUD ${w.wl} stopped at its ceiling: `);
		expect(loud[0]!.state).toBe("L2");
		expect(d.take(loud)).toHaveLength(1);
		w.send(3);
		expect(w.alerts()[0]!.line).toStartWith(`ALERT CRITICAL ${w.wl} stopped at its ceiling: `);
		expect(d.take(w.alerts())).toHaveLength(1);
		// the line is not consumed by its delivery: it stays until the episode ends
		expect(w.alerts()).toHaveLength(1);
	});

	test("the popup at the current level: shown, then failures counted against the limit with the newest error, then answered", () => {
		const w = world();
		const ep = w.raise();
		w.send(2);
		w.popup(w.key, ep, 2, "showing");
		expect(w.alerts()[0]!.line).toEndWith(`(issue ${ISSUE}; popup shown)`);
		w.popup(w.key, ep, 2, "failed", "osascript exit 1: not authorized");
		w.popup(w.key, ep, 2, "unstarted", "spawn ENOENT osascript");
		const failing = w.alerts()[0]!;
		expect(failing.line).toEndWith(`(issue ${ISSUE}; popup failed 2 of ${ALERT_POPUP_ATTEMPTS}: spawn ENOENT osascript)`);
		expect(failing.state).toMatch(/^L2 [0-9a-f]{8}$/);
		w.popup(w.key, ep, 2, "ok", "OK");
		expect(w.alerts()[0]!.line).toEndWith(`(issue ${ISSUE}; popup answered OK)`);
		// level 2's popup rows do not speak for level 3
		w.send(3);
		expect(w.alerts()[0]!.line).toEndWith(`(issue ${ISSUE}; popup not yet)`);
	});

	test("an issue gh could not file says so with gh's error, a new state; a later sent level clears it", () => {
		const w = world();
		const ep = w.write(w.key, { row: "raised", kind: "ceiling", start: 1, digest: "0123456789ab", words: alertWords(w.subject) });
		expect(w.alerts()[0]!.line).toEndWith("(issue not filed yet; popup not yet)");
		w.write(w.key, { row: "level", level: 1, step: "sending", url: null });
		w.write(w.key, { row: "error", channel: "gh", text: "gh: HTTP 502 Bad Gateway" });
		const failed = w.alerts()[0]!;
		expect(failed).toMatchObject({ rowId: ep });
		expect(failed.line).toEndWith("(issue not filed: gh: HTTP 502 Bad Gateway; popup not yet)");
		expect(failed.state).toMatch(/^L1 [0-9a-f]{8}$/);
		w.write(w.key, { row: "level", level: 1, step: "sent", url: ISSUE });
		expect(w.alerts()[0]!).toMatchObject({ state: "L1", line: expect.stringMatching(new RegExp(`\\(issue ${ISSUE}; popup not yet\\)$`)) });
	});

	test("an acked or closed episode has no line; a new episode of the key has one again", () => {
		const w = world();
		w.raise();
		w.write(w.key, { row: "acked", why: "ack instruction in-x" });
		expect(w.alerts()).toEqual([]);
		w.write(w.key, { row: "closed", why: "Jo answered extend" });
		expect(w.alerts()).toEqual([]);
		const again = w.raise();
		expect(w.alerts().map((l) => l.rowId)).toEqual([again]);
	});

	test("a later `updated` row's words are the line's; a row with no words (written before them) says its key", () => {
		const w = world();
		w.raise();
		w.write(w.key, { row: "updated", digest: "ba9876543210", words: alertWords({ ...w.subject, text: "spent $160.02 of $150" }) });
		expect(w.alerts()[0]!.line).toContain(": spent $160.02 of $150 — ");
		w.write("main:thewolff/old", { row: "raised", kind: "main-red", start: 1, digest: "0123456789ab" });
		const old = w.alerts().find((l) => l.line.includes("main:thewolff/old"))!;
		expect(old.workloadId).toBe(STANDING_WORKLOAD_ID);
		expect(old.line).toStartWith("ALERT main:thewolff/old: no words recorded for this alert — ");
	});

	test("a question with a q: alert at level 2 keeps its LOUD tag on its own line, and the ALERT line carries the issue and popup", () => {
		const w = world();
		const sl = w.ledger.addSlice({ by: "lane-a", workloadId: w.wl, task: "ask", doneCondition: "answered", inputs: "none" });
		const q = w.ledger.raiseQuestion({ by: "lane-a", workloadId: w.wl, sliceId: sl, body: "#101 failed twice: skip or retry?", options: ["skip", "retry"] });
		const key = `q:${q}`;
		w.write(key, { row: "raised", kind: "train", start: 1, digest: "0123456789ab", words: alertWords({ title: `${w.wl} #101 needs you`, text: "#101 failed twice", next: `answer ${q}`, workloadId: w.wl }) });
		w.write(key, { row: "level", level: 1, step: "sent", url: ISSUE });
		w.write(key, { row: "level", level: 2, step: "sent", url: null });
		const all = errorLines(w.ledger);
		expect(all.find((l) => l.kind === "question" && l.rowId === q)!.line).toStartWith("LOUD (unacknowledged 4 h): ");
		expect(all.filter((l) => l.kind === "alert").map((l) => l.line)).toEqual([`ALERT LOUD ${w.wl} #101 needs you: #101 failed twice — answer ${q} (issue ${ISSUE}; popup not yet)`]);
	});

	test("rows that are not ALERT_BY's are no alert", () => {
		const w = world();
		w.ledger.recordEntry({ by: "lane-a", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertBody(w.key, { row: "raised", kind: "ceiling", start: 1, digest: "0123456789ab", words: alertWords(w.subject) }) });
		expect(w.alerts()).toEqual([]);
	});
});
