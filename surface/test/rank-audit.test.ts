// new guard: no fail-before
//
// sl-rank-audit of wl-mv8k039gvogt8g (PLAN rev 5 § 2 D6, § 3 T13–T14): the weekly audit surface/src/rank-audit.ts, which
// does not exist before this slice. The pick rows are written the way their paths write them (sl-rank-tool's as2_rank
// `first`, sl-rank-launch's launch tool and interactive reservation): the `rank-shown: … by pick` snapshot from
// `rankPick` and the pick row in one `ledger.write`; the reservation through the ledger's own `reserveLane` with the
// snapshot written inside its decision. Times are UTC instants from a fixed base; every signal is undated, so no
// assertion depends on the local calendar day.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload } from "../src/identity";
import { controlEntries, decideInteractive, laneModelBody, laneStartedBody, launchRequestedBody } from "../src/launch";
import {
	briefHash, currentGoals, formatOverride, formatShown, formatSignal, goalsHash, parseAudit, rankDay, rankPick, type SignalAnswer,
	type SignalAnswers,
} from "../src/rank";
import { auditDue, rankAudit, runAudit } from "../src/rank-audit";
import { RANK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const BASE = Date.parse("2026-10-14T12:00:00.000Z");
const t = (d: number, h = 0): string => new Date(BASE + d * 86_400_000 + h * 3_600_000).toISOString();

const bool = (x: number): SignalAnswer => ({ type: "bool", bool: x });
/** No goals answered, every bool low but `unblocks_jo`, no deadline: score 0.2 + 0.2 × (unblocks − 0.1). */
const answers = (unblocks: number): SignalAnswers => ({
	unblocks_jo: bool(unblocks), cuts_spend: bool(0.1), fixes_breakage: bool(0.1), states_deadline: bool(0.05), irreversible: bool(0.05),
	builds_enforcer: bool(0.1), deadline_when: { type: "choice", choice: "none", confidence: 0.9 },
});

function world() {
	const c = clock(t(0));
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	return { ledger, c };
}
function open(ledger: Ledger, title: string, unblocks: number, mode: "autonomous" | "user-driven" = "autonomous"): string {
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: `${title}\n\nbody of ${title}`, stakes: "normal", mode });
	const body = formatSignal({
		brief: briefHash(ledger.workload(wl)!.brief), goals: goalsHash([]), askedOn: "2026-10-14", judge: "typesafe/jev-1.13.0", tokens: 800, cost: 0.00003,
		answers: answers(unblocks),
	});
	ledger.recordEntry({ by: RANK_BY, workloadId: wl, kind: "assumption", body });
	return wl;
}
/** The audit snapshot every pick path writes in its own transaction: Jev's waiting-only, unpinned order now. */
function snapshot(ledger: Ledger): string {
	const now = ledger.now();
	return ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatShown({ by: "pick", goals: currentGoals(ledger, now).hash, items: rankPick(ledger, now) }) });
}
/** An ordinary view (`by orchestrator`): full order, never used by the audit. */
function shownByOrchestrator(ledger: Ledger, items: { workloadId: string; state: "running" | "waiting" }[]): string {
	return ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatShown({ by: "orchestrator", goals: goalsHash([]), items }) });
}
/** as2_rank { first }: snapshot, then `rank-override:` naming it (D4 step 3c). */
function pickFirst(ledger: Ledger, wl: string, input: string): void {
	ledger.write(() => {
		const shown = snapshot(ledger);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: wl, input, shown }) });
	});
}
/** orchestrator_launch_lane: snapshot, Jo's `lane-model:` when named, then `launch-requested:`, in one write. */
function pickLaunch(ledger: Ledger, wl: string, o: { model?: boolean } = {}): void {
	ledger.write(() => {
		snapshot(ledger);
		if (o.model) ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody("anthropic/claude-opus-4-6", ledger.now()) });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
	});
}
/** `as2 lane <wl>`: the reservation's decision writes the snapshot inside reserveLane's transaction, before `launch: … cause interactive`. */
function pickInteractive(ledger: Ledger, wl: string, started: boolean): string {
	const r = ledger.reserveLane(wl, {
		by: LANE_STARTER_BY, cap: 4, leaseMs: 30 * 86_400_000, requestedBy: "jo",
		decide: (rows) => {
			const v = decideInteractive(rows);
			if (v.launch) snapshot(ledger);
			return v;
		},
	});
	if (!r.ok) throw new Error(`reservation refused: ${r.reason}`);
	if (started) ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: laneStartedBody(r.laneId, { pid: 4242, start: "Wed Oct 14 12:00:00 2026", session: null, argv: [], runnerPid: 4241 }) });
	return r.laneId;
}

describe("T13 audit picks (D6)", () => {
	test("each pick kind is scored against its own by-pick snapshot; running lanes are absent; unscorable and start-failed picks; hand arithmetic", () => {
		const { ledger, c } = world();
		// Jev's order by score: F 0.38, E 0.37, A 0.36, B 0.34, C 0.32, D 0.22, G 0.20.
		const A = open(ledger, "Alpha", 0.9);
		const B = open(ledger, "Bravo", 0.8);
		const C = open(ledger, "Charlie", 0.7);
		const D = open(ledger, "Delta", 0.2);
		const E = open(ledger, "Echo", 0.95, "user-driven");
		const F = open(ledger, "Foxtrot", 1.0);
		const G = open(ledger, "Golf", 0.1, "user-driven");
		shownByOrchestrator(ledger, [F, E, A, B, C, D, G].map((workloadId) => ({ workloadId, state: "waiting" as const })));

		// Before the window: a by-pick launch of A, which must not count.
		c.at(t(0, 2));
		pickLaunch(ledger, A);

		// Day 1: an autonomous lane runs F; Jo reserves E interactively. E is Jev's #1 among the waiting E, A, B, C, D, G.
		c.at(t(1));
		expect(ledger.claimWorkload(F, { by: LANE_STARTER_BY, holder: "lane-foxtrot-1", leaseMs: 30 * 86_400_000 }).won).toBe(true);
		pickInteractive(ledger, E, true);
		// Day 2: Jo's "C first" while F (autonomous) and E (interactive) run: waiting A, B, C, D, G → C is #3 of 5.
		c.at(t(2));
		// An ordinary view in which C sits at #1 (its pin applied): the audit must not read it.
		const view = shownByOrchestrator(ledger, [C, F, E, A, B, D, G].map((workloadId) => ({ workloadId, state: workloadId === F || workloadId === E ? "running" as const : "waiting" as const })));
		pickFirst(ledger, C, "in-cfirst");
		// Day 3: Jo's launch of D, with a model named in the same write: D is #4 of 5.
		c.at(t(3));
		pickLaunch(ledger, D, { model: true });
		// Day 4: Jo reserves G, whose lane never starts: G is #5 of 5, scored and marked.
		c.at(t(4));
		pickInteractive(ledger, G, false);
		// Day 5: two side-effect relaunch requests with no snapshot (surface/src/input.ts mode-flip, ceiling extend), the
		// first right after G's reservation and its snapshot: not picks.
		c.at(t(5));
		ledger.recordEntry({ by: SURFACE_BY, workloadId: B, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "mode-flip") });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: D, kind: "assumption", body: launchRequestedBody("jo", ledger.now(), "ceiling extend") });
		// Then Jo's "B first" naming an ordinary view instead of a by-pick snapshot: a pick, unscorable.
		c.at(t(5, 1));
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatOverride({ workloadId: B, input: "in-bfirst", shown: view }) });
		// Day 6: a launch of A whose snapshot lacks A.
		c.at(t(6));
		ledger.write(() => {
			ledger.recordEntry({ by: RANK_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: formatShown({ by: "pick", goals: goalsHash([]), items: [{ workloadId: C, state: "waiting" }, { workloadId: D, state: "waiting" }] }) });
			ledger.recordEntry({ by: SURFACE_BY, workloadId: A, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
		});

		const dir = tmp("rank-audit");
		const { audit, report } = rankAudit(ledger, t(1, -1), t(7), dir);
		// picks: E (interactive), C (first), D (launch), G (interactive), B (first, no by-pick snapshot), A (launch, not in
		// snapshot); the two side-effect requests are not picks.
		// scorable E #1/6 → 100, C #3/5 → 50, D #4/5 → 25, G #5/5 → 0; meanpct 175/4 = 43.75 → 43.8.
		expect(audit).toEqual({ from: t(1, -1), to: t(7), picks: 6, scorable: 4, top1: 1, top3: 2, meanpct: 43.8, report: join(dir, `${rankDay(t(7))}.md`) });

		const line = (wl: string) => report.split("\n").find((l) => l.startsWith("- ") && l.includes(` ${wl}: `)) ?? "";
		expect(report.split("\n").filter((l) => l.startsWith("- ") && / launch wl-\S+: /.test(l)).map((l) => l.split(" ")[3])).toEqual([`${D}:`, `${A}:`]);
		expect(report).toContain("launch requests without a pick snapshot (cancel/extend/mode-flip side effects): 2\n");
		expect(line(E)).toContain(`interactive ${E}: #1 of 6 (pct 100)`);
		expect(line(E)).not.toContain("start failed");
		expect(line(C)).toContain(`first ${C}: #3 of 5 (pct 50)`);
		expect(line(D)).toContain(`launch ${D}: #4 of 5 (pct 25)`);
		expect(line(G)).toContain(`interactive ${G}: #5 of 5 (pct 0); start failed`);
		expect(line(B)).toContain(`first ${B}: -; unscorable: no by-pick snapshot`);
		expect(line(A)).toContain("unscorable: picked item not in its snapshot");
		expect(report).not.toContain(t(0, 2));

		// Overrides: every scorable pick not at #1, the picked item and each item Jev ranked above it, with their terms.
		const section = (wl: string) => report.split("\n### ").find((s) => s.startsWith(`${wl} picked`)) ?? "";
		expect(report).not.toContain(`### ${E} picked`);
		expect(section(C).split("\n").filter((l) => l.startsWith("- "))).toEqual([
			`- picked ${C} Charlie (score 0.32): goal_max 0.5 · unblocks_jo 0.7 · fixes_breakage 0.1 · urgency 0 · cuts_spend 0.1`,
			`- Jev #1 ${A} Alpha (score 0.36): goal_max 0.5 · unblocks_jo 0.9 · fixes_breakage 0.1 · urgency 0 · cuts_spend 0.1`,
			`- Jev #2 ${B} Bravo (score 0.34): goal_max 0.5 · unblocks_jo 0.8 · fixes_breakage 0.1 · urgency 0 · cuts_spend 0.1`,
		]);
		expect(section(D).split("\n").filter((l) => l.startsWith("- Jev #")).map((l) => l.split(" ")[3])).toEqual([A, B, C]);
		expect(section(G).split("\n").filter((l) => l.startsWith("- Jev #")).length).toBe(4);
	});
});

describe("T14 audit due (D6)", () => {
	test("due 7 days after the first rank-shown, not at 6 d 23 h; a picks-0 week writes the report and the row; then not due for 7 days", () => {
		const { ledger, c } = world();
		expect(auditDue(ledger, t(30))).toBe(false);
		const dir = join(tmp("rank-audit"), "reports");
		shownByOrchestrator(ledger, []);
		expect(auditDue(ledger, t(7, -1))).toBe(false);
		expect(runAudit(ledger, t(7, -1), { reportDir: dir })).toBeNull();
		expect(existsSync(dir)).toBe(false);
		expect(auditDue(ledger, t(7))).toBe(true);

		c.at(t(7));
		const audit = runAudit(ledger, t(7), { reportDir: dir });
		const path = join(dir, `${rankDay(t(7))}.md`);
		expect(audit).toEqual({ from: t(0), to: t(7), picks: 0, scorable: 0, top1: 0, top3: 0, meanpct: null, report: path });
		expect(readFileSync(path, "utf8")).toContain("No picks in the window.");
		const rows = controlEntries(ledger.entries(STANDING_WORKLOAD_ID)).filter((e) => e.prefix === "rank-audit");
		expect(rows.map((r) => [r.createdBy, parseAudit(r.body)])).toEqual([[SURFACE_BY, audit]]);
		expect(rows[0]!.body).toContain("picks 0 ");

		expect(runAudit(ledger, t(7, 1), { reportDir: dir })).toBeNull();
		expect(auditDue(ledger, t(14, -1))).toBe(false);
		expect(auditDue(ledger, t(14))).toBe(true);
		expect(controlEntries(ledger.entries(STANDING_WORKLOAD_ID)).filter((e) => e.prefix === "rank-audit").length).toBe(1);
	});
});
