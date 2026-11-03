// The cutover (PLAN wl-mw0vs9uc3xqtka D3 "Legacy adoption"): an alert the retired quota-move path already filed is adopted
// by the alert pass, never filed a second time. A temp ledger and the recording gh of alert-world.ts; nothing real.
import { describe, expect, test } from "bun:test";
import { LANE_RUNNER_BY } from "../../ledger/src/index";
import { alertRecords, openEpisode } from "../src/alert-path";
import { controlEntries, laneHeadroomBody } from "../src/launch";
import { commentMarker, issueMarker, QUOTA_MOVE_ALERT_PREFIX, recordQuotaMove } from "../src/quota-move-alert";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { alertPass } from "../scripts/alert-tick";
import { ISSUE, world } from "./alert-world";

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
