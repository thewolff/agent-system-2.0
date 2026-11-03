// The alert pass (PLAN wl-mw0vs9uc3xqtka D3; R1, R8-R24): one pass over a temp ledger with recording fakes for gh, the popup
// spawn, ps and kill. No real gh, popup or signal is ever used.
import { describe, expect, test } from "bun:test";
import { alertMarker, alertRecords, openEpisode } from "../src/alert-path";
import { apply, interpret } from "../src/input";
import { ALERT_BY, alertPopupBody, controlEntries } from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { alertPass, lockedAlertPass } from "../scripts/alert-tick";
import { POPUP_TAG_ENV } from "../scripts/alert-popup";
import { ceilingStopped, ISSUE, world } from "./alert-world";

describe("one pass over a ceiling-stopped workload (D3, R8)", () => {
	test("an urgent workload: the raised row, the issue with its create marker, the level-2 comment and label, and the popup kick", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, 'Jo said "fix it ASAP": move the header offset into a token');
		expect(alertPass(w.deps).problems).toEqual([]);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep).toMatchObject({ opened: "raised", kind: "ceiling", start: 2, url: ISSUE });
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} raised ceiling start 2 `))).toHaveLength(1);
		expect([...ep.sent.keys()]).toEqual([1, 2]);
		const [issue] = w.g.issues;
		expect(w.g.issues).toHaveLength(1);
		expect(issue!.body).toContain(alertMarker(key, ep.id, "create"));
		expect(issue!.labels).toEqual(["as2-train", "loud"]);
		expect(issue!.comments).toHaveLength(1);
		expect(issue!.comments[0]).toContain(alertMarker(key, ep.id, "level 2"));
		expect(issue!.comments[0]).toContain("@thewolff");
		expect(w.spawns).toHaveLength(1);
		expect(w.spawns[0]!.argv.slice(-3)).toEqual([key, ep.id, "2"]);
		expect(w.spawns[0]!.env[POPUP_TAG_ENV]).toBe(`${ep.id}:2:1`);
		expect(w.rows()).toContain(alertPopupBody(key, ep.id, 2, "spawning", "attempt=1"));
		// A second pass changes nothing: no second issue, comment or popup.
		const before = w.g.calls.filter((a) => a[1] === "create" || a[1] === "comment").length;
		alertPass(w.deps);
		expect(w.g.calls.filter((a) => a[1] === "create" || a[1] === "comment").length).toBe(before);
		expect(w.spawns).toHaveLength(1);
	});

	test("a workload that is not urgent starts at level 1: the issue, no comment, no popup", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(`ceiling:${wl}`))!;
		expect(ep.start).toBe(1);
		expect([...ep.sent.keys()]).toEqual([1]);
		expect(w.g.issues[0]!.comments).toEqual([]);
		expect(w.spawns).toEqual([]);
	});

	test("Jo's extend clears the subject: the issue is closed with a comment naming why, and `closed` is written", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const cmd = interpret(w.ledger, `ceiling 100 ${wl}`);
		if (cmd === null) throw new Error(`interpret refused "ceiling 100 ${wl}"`);
		apply(w.ledger, cmd);
		alertPass(w.deps);
		expect(w.g.issues[0]!.state).toBe("CLOSED");
		expect(w.rows().some((r) => r.startsWith(`alert: ceiling:${wl} closed `))).toBe(true);
	});
});

describe("urgency is visible where Jo reads the alert (D5)", () => {
	test("a brief citing Jo's urgent input: the issue body and the needs-you line both say `urgent (from <input id>)`", () => {
		const w = world();
		const inputId = w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: "fix the header offset, urgent", author: "jo", channel: "surface" });
		const wl = ceilingStopped(w.ledger, `input ${inputId}: move the header offset into a token`);
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		expect(ep.start).toBe(2);
		expect(w.g.issues[0]!.body).toContain(`urgent (from ${inputId})`);
		expect(ep.words?.line).toEndWith(` — urgent (from ${inputId})`);
		// Applied once: the issue says it on one line only.
		expect(w.g.issues[0]!.body.split(`urgent (from ${inputId})`)).toHaveLength(2);
	});

	test("a workload that is not urgent: neither the issue nor the line says urgent", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(`ceiling:${wl}`))!;
		expect(w.g.issues[0]!.body).not.toContain("urgent (from");
		expect(ep.words?.line).not.toContain("urgent");
	});
});

describe("gh failures (D3: one attempt per pass, the error on the subject)", () => {
	test("a failed issue create writes `error gh`, is not retried inside the pass, and the next pass files it", () => {
		let down = true;
		const w = world({ fail: (a) => down && a[0] === "issue" && a[1] === "create" });
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		expect(w.g.calls.filter((a) => a[1] === "create")).toHaveLength(1);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} error gh `))).toHaveLength(1);
		expect(w.rows().find((r) => r.startsWith(`alert: ${key} error gh `))).toContain("HTTP 502");
		// The same failure again writes no second error row.
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ${key} error gh `))).toHaveLength(1);
		down = false;
		alertPass(w.deps);
		expect(w.g.issues).toHaveLength(1);
		expect(w.rows().some((r) => r === `alert: ${key} level 1 sent ${ISSUE}`)).toBe(true);
	});

	test("Jo closing the issue acks the alert: `acked`, and no level is sent after it", () => {
		const w = world();
		const wl = ceilingStopped(w.ledger, "Move the header offset into a token");
		alertPass(w.deps);
		w.g.issues[0]!.state = "CLOSED";
		alertPass(w.deps);
		w.c.plusHours(9);
		alertPass(w.deps);
		expect(w.rows().filter((r) => r.startsWith(`alert: ceiling:${wl} acked `))).toHaveLength(1);
		expect(w.g.issues[0]!.comments).toEqual([]);
	});
});

describe("the pass lock (D3)", () => {
	test("a pass that finds the lock held runs nothing and says so in one line", () => {
		const w = world();
		ceilingStopped(w.ledger, "Move the header offset into a token");
		const r = lockedAlertPass(w.deps, () => ({ owner: { pid: 9, start: "Tue Nov  3 10:00:00 2026" }, state: "same" }));
		expect(r).toBeNull();
		expect(w.g.calls).toEqual([]);
		expect(w.log).toEqual([expect.stringContaining("another pass holds the lock")]);
	});

	test("the lock is released after the pass", () => {
		const w = world();
		let released = 0;
		expect(lockedAlertPass(w.deps, () => ({ release: () => void released++ }))).toEqual({ problems: [] });
		expect(released).toBe(1);
	});
});

describe("popup settlement (D3: pid and lstart pairs and the AS2_ALERT_POPUP tag only)", () => {
	const LS = "Tue Nov  3 10:00:00 2026";
	test("a worker past its claim is gone while its tagged osascript remains: SIGTERM to the tagged one only, then `failed` once it is gone", () => {
		let snapshot = "";
		const w = world({ ps: () => snapshot });
		const wl = ceilingStopped(w.ledger, 'Jo said "ASAP"');
		alertPass(w.deps);
		const key = `ceiling:${wl}`;
		const ep = openEpisode(alertRecords(controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID))).get(key))!;
		const write = (step: Parameters<typeof alertPopupBody>[3], detail?: string) =>
			w.ledger.recordEntry({ by: ALERT_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: alertPopupBody(key, ep.id, 2, step, detail) });
		write("claim", `pid=500 pgid=500 lstart=${LS.replace(/ /g, "_")} attempt=1 until=2026-11-04T00:00:00.000Z`);
		write("showing");
		const tag = `${POPUP_TAG_ENV}=${ep.id}:2:1`;
		// The worker (500) is gone; its osascript (600) carries the tag; 700 reuses no identity and carries another tag.
		snapshot = [`  600     1   500 ${LS} /usr/bin/osascript -e x ${tag}`, `  700     1   700 ${LS} /usr/bin/osascript ${POPUP_TAG_ENV}=en-other:2:1`].join("\n");
		alertPass(w.deps);
		expect(w.kills).toEqual([[600, "SIGTERM"]]);
		expect(w.rows().some((r) => r.startsWith(`alert-popup: ${key} ${ep.id} 2 terminating worker ended after showing members=600:`))).toBe(true);
		// 30 s later it still matches: SIGKILL to it alone.
		w.c.plusHours(31 / 3600);
		alertPass(w.deps);
		expect(w.kills).toEqual([[600, "SIGTERM"], [600, "SIGKILL"]]);
		// A process with pid 600 but another start time is not it: the attempt is settled, nothing is signalled.
		snapshot = `  600     1   600 Tue Nov  3 11:00:00 2026 /bin/sleep 5`;
		alertPass(w.deps);
		expect(w.kills).toHaveLength(2);
		expect(w.rows().some((r) => r === `alert-popup: ${key} ${ep.id} 2 failed worker ended after showing`)).toBe(true);
		// Settled with attempts left: the next attempt is spawned with its own tag.
		alertPass(w.deps);
		expect(w.spawns.at(-1)!.env[POPUP_TAG_ENV]).toBe(`${ep.id}:2:2`);
	});

	test("a ps refusal is the key's `error popup` and leaves the claim unsettled: nothing signalled, no new worker", () => {
		const w = world({ ps: () => { throw new Error("ps -A -E exited 126: Operation not permitted"); } });
		const wl = ceilingStopped(w.ledger, 'Jo said "ASAP"');
		alertPass(w.deps);
		alertPass(w.deps);
		expect(w.kills).toEqual([]);
		expect(w.spawns).toHaveLength(1);
		expect(w.rows().some((r) => r.startsWith(`alert: ceiling:${wl} error popup ps -A -E could not be read`))).toBe(true);
	});
});
