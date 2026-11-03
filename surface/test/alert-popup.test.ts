// The detached popup worker (PLAN wl-mw0vs9uc3xqtka D3 popups): its claim, its ok/failed rows, and the pass's settlement of a
// legacy quota-move popup, on fake ps snapshots and a fake alarm. No real popup, ps or signal is ever used.
import { describe, expect, test } from "bun:test";
import { type AlertEpisode, alertRecords, openEpisode } from "../src/alert-path";
import { controlEntries } from "../src/launch";
import type { AlarmOutcome } from "../src/notify";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { alertPass } from "../scripts/alert-tick";
import { type LegacyClaim, legacyPopupRecord, parsePs, POPUP_KILL_AFTER_MS, POPUP_TAG_ENV, settleLegacy, workerRun } from "../scripts/alert-popup";
import type { QuotaMove } from "../src/quota-move-alert";
import { type AlertWorld, ceilingStopped, world } from "./alert-world";

const LS = "Tue Nov  3 10:00:00 2026";

/** An urgent ceiling alert after one pass: its key and its open episode (the pass spawned the level-2 popup, attempt 1). */
interface UrgentEpisode extends AlertWorld {
	key: string;
	ep: AlertEpisode;
}

function urgentEpisode(): UrgentEpisode {
	const w = world();
	const wl = ceilingStopped(w.ledger, 'Jo said "ASAP": move the header offset');
	alertPass(w.deps);
	const key = `ceiling:${wl}`;
	const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
	return { ...w, key, ep };
}

function run(w: UrgentEpisode, outcome: AlarmOutcome, o: { attempt?: number } = {}) {
	const shown: { title: string; text: string }[] = [];
	const errs: string[] = [];
	const code = workerRun([w.key, w.ep.id, "2"], {
		ledger: w.ledger, env: { [POPUP_TAG_ENV]: `${w.ep.id}:2:${o.attempt ?? 1}` }, pid: 500,
		identity: () => ({ pgid: 500, lstart: LS }),
		alarm: (title, text) => {
			shown.push({ title, text });
			return outcome;
		},
		err: (l) => errs.push(l),
	});
	return { code, shown, errs };
}

describe("the popup worker (D3)", () => {
	test("it claims its attempt with its pid, pgid and lstart, shows the alert's words and issue, and writes ok when answered", () => {
		const w = urgentEpisode();
		const r = run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		expect(r.code).toBe(0);
		expect(r.shown).toHaveLength(1);
		expect(r.shown[0]!.text).toContain(w.ep.url!);
		expect(r.shown[0]!.text).toContain(`ack ${w.key}`);
		const rows = w.rows().filter((x) => x.startsWith(`alert-popup: ${w.key} ${w.ep.id} 2 `));
		expect(rows.find((x) => x.includes(" claim "))).toContain(`pid=500 pgid=500 lstart=${LS.replace(/ /g, "_")} attempt=1 until=`);
		expect(rows.at(-2)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 showing`);
		expect(rows.at(-1)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 ok button=Read it`);
	});

	test("a popup that could not be shown writes failed with quiet-alarm's reason and exits 1", () => {
		const w = urgentEpisode();
		const r = run(w, { state: "failed", detail: "quiet-alarm exited 1: osascript: not authorised", stderr: "osascript: not authorised" });
		expect(r.code).toBe(1);
		expect(w.rows().at(-1)).toBe(`alert-popup: ${w.key} ${w.ep.id} 2 failed quiet-alarm exited 1: osascript: not authorised`);
		expect(r.errs).toEqual([expect.stringContaining("osascript: not authorised")]);
	});

	test("a second worker for the same attempt is refused at its claim and shows nothing", () => {
		const w = urgentEpisode();
		run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		const r = run(w, { state: "answered", detail: "button=Read it", stderr: "", otherStderr: "" });
		expect(r.code).toBe(1);
		expect(r.shown).toEqual([]);
		expect(w.rows().at(-1)).toStartWith(`alert-popup: ${w.key} ${w.ep.id} 2 failed claim refused: `);
	});

	test("a worker started without its AS2_ALERT_POPUP tag exits 2 without writing a row", () => {
		const w = urgentEpisode();
		const before = w.rows().length;
		const errs: string[] = [];
		const code = workerRun([w.key, w.ep.id, "2"], { ledger: w.ledger, env: {}, pid: 500, identity: () => ({ pgid: 500, lstart: LS }), alarm: () => { throw new Error("must not show"); }, err: (l) => errs.push(l) });
		expect(code).toBe(2);
		expect(w.rows()).toHaveLength(before);
		expect(errs[0]).toContain("usage: alert-popup.ts");
	});
});

describe("a legacy quota-move popup at cutover (D3 legacy adoption)", () => {
	const move: QuotaMove = {
		eventId: "E-1", messageId: "msg-q-1", workloadId: "wl-t1", subject: "lane-t-1", kind: "lane",
		from: "anthropic/claude-opus-5-5", to: "openai-codex/gpt-6-sol", reason: "weekly quota at 96%", at: "2026-11-03T09:00:00.000Z",
	};
	const claim: LegacyClaim = { pid: 900, attempt: 1 };
	const OWNER = `/opt/homebrew/bin/bun surface/scripts/lane.ts move-alert wl-t1 E-1`;
	test("no helper left: settled with no signal; a process on the claim's pid running something else is a reused pid, not the worker", () => {
		expect(settleLegacy(legacyPopupRecord([]), [], claim, move, "2026-11-03T10:01:00.000Z")).toEqual({ do: "settle", text: "settled worker ended without a result" });
		const reused = parsePs(`  900     1   900 Tue Nov  3 11:00:00 2026 /bin/sleep 5`);
		expect(settleLegacy(legacyPopupRecord([]), reused, claim, move, "2026-11-03T10:01:00.000Z")).toEqual({ do: "settle", text: "settled claim pid reused" });
	});

	test("a live legacy worker is sent SIGTERM, then SIGKILL only once the grace has passed", () => {
		const procs = parsePs([`  900     1   900 ${LS} ${OWNER}`, `  901   900   900 ${LS} /usr/bin/say hello`, `  950     1   950 ${LS} /bin/sleep 5`].join("\n"));
		if (procs.length !== 3) throw new Error(`parsePs read ${procs.length} processes from a three-line snapshot`);
		const t0 = "2026-11-03T10:01:00.000Z";
		const first = settleLegacy(legacyPopupRecord([]), procs, claim, move, t0);
		if (first === null || first.do !== "terminate") throw new Error(`settleLegacy gave ${JSON.stringify(first)} for a live legacy worker; expected terminate`);
		expect(first.members.map((p) => p.pid).sort()).toEqual([900, 901]);
		const rec = legacyPopupRecord([first.text]);
		expect(settleLegacy(rec, procs, claim, move, "2026-11-03T10:01:10.000Z")).toBeNull();
		const late = new Date(Date.parse(t0) + POPUP_KILL_AFTER_MS).toISOString();
		expect(settleLegacy(rec, procs, claim, move, late)).toMatchObject({ do: "kill" });
		expect(settleLegacy(rec, [], claim, move, late)).toEqual({ do: "settle", text: "settled cancelled at cutover" });
	});
});
