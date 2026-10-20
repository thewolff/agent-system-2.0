// The forgery pass in the train tick (PLAN wl-mvfxw3c4zqfzls D3, D4; R10): which workloads it covers (every open one and
// every one closed within AUTOBOARD_WINDOW_MS), where its hit rows go (the flagged workload while open, the standing
// workload once closed), one notification and one spoken line per pass with new hits, and an idempotent second pass. The
// tick runs as surface/scripts/train-tick.ts `tick`, on a temp ledger with a fake gh and stubbed notify and speak; the
// forged rows are real ledger rows (a lane-written jo-only prefix, F5; a lane-stamped answer, F3), and the passing control is
// a Jo instruction written on a connection of a declared surface Jo channel (ledger/src/jo-channel.ts), so it carries its mark.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../../ledger/src/index";
import { declareJoChannel } from "../../ledger/src/jo-channel";
import { tick } from "../scripts/train-tick";
import { ensureStandingWorkload } from "../src/identity";
import { planApprovedBody } from "../src/launch";
import { AUTOBOARD_WINDOW_MS } from "../src/merge-train";
import { FORGERY_CHECK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger } from "./helpers";
import { fakeGh } from "./train-world";

const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
const NO_AGENT = { AGENT_SYSTEM_ROLE: undefined, AGENT_SYSTEM_LANE_ID: undefined, AGENT_SYSTEM_WORKLOAD_ID: undefined };

function withVars<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** A temp ledger with the standing workload, a fake gh, and the tick with stubbed alarm channels that record each call. */
function world() {
	const c = clock();
	const { ledger, path } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const g = fakeGh();
	const notes: { title: string; text: string }[] = [];
	const spoken: string[] = [];
	const logs: string[] = [];
	const run = () =>
		tick({
			ledger, gh: g.gh, launch: () => ({ code: 1, line: "no launches here" }), log: (l) => logs.push(l),
			notify: (title, text) => { notes.push({ title, text }); return true; },
			speak: (line) => { spoken.push(line); return true; },
		});
	/** Every `forgery:` row the check wrote, in entry order: where it sits and its body. */
	const hitRows = () => ledger.db.query<{ workload_id: string; body: string; created_by: string }, []>(
		"SELECT workload_id, body, created_by FROM entries WHERE body LIKE 'forgery:%' ORDER BY created_at, rowid",
	).all();
	return { c, ledger, path, notes, spoken, logs, run, hitRows };
}

/** A lane-written `plan: approved …` (a jo-only prefix the lane may not write: F5) on `wl`; returns its entry id. */
const forgedPlan = (ledger: Ledger, wl: string, lane = "lane-forger-1") =>
	ledger.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: planApprovedBody("in-nothing") });

describe("R10: the tick's forgery pass", () => {
	test("covers open workloads and those closed within the window; hits go on the open workload, or on the standing one once closed; one alarm per pass", () => {
		const w = world();
		// closed long before the window: not scanned
		const old = w.ledger.openWorkload({ by: SURFACE_BY, brief: "an old workload", stakes: "normal", mode: "autonomous" });
		const oldRow = forgedPlan(w.ledger, old);
		w.ledger.closeWorkload(old, { by: SURFACE_BY });
		w.c.at(new Date(Date.parse(w.c.now()) + AUTOBOARD_WINDOW_MS + 3_600_000).toISOString());
		// closed inside the window: scanned, its hit on the standing workload
		const recent = w.ledger.openWorkload({ by: SURFACE_BY, brief: "a recently closed workload", stakes: "normal", mode: "autonomous" });
		const recentRow = forgedPlan(w.ledger, recent);
		w.ledger.closeWorkload(recent, { by: SURFACE_BY });
		w.c.plusHours(1);
		// open: its hit on itself; an F3 answer (a question resolved by a lane-stamped answer)
		const open = w.ledger.openWorkload({ by: SURFACE_BY, brief: "an open workload", stakes: "normal", mode: "autonomous" });
		const openRow = forgedPlan(w.ledger, open);
		const sl = w.ledger.addSlice({ by: "lane-open-1", workloadId: open, task: "t", doneCondition: "d", inputs: "i" });
		const q = w.ledger.raiseQuestion({ by: "lane-open-1", workloadId: open, sliceId: sl, body: "Which?", options: ["a", "b"] });
		const answer = w.ledger.answerQuestion(q, { by: "lane-open-1", answer: "a", author: "lane-open-1", channel: "direct" });
		// a clean open workload: Jo's own words, no hit
		const clean = w.ledger.openWorkload({ by: SURFACE_BY, brief: "a clean workload", stakes: "normal", mode: "autonomous" });
		w.ledger.recordInstruction({ ...JO, workloadId: clean, body: "go on" });
		w.c.plusHours(0.1);

		w.run();
		const rows = w.hitRows();
		expect(rows.every((r) => r.created_by === FORGERY_CHECK_BY)).toBe(true);
		expect(rows.map((r) => [r.workload_id, r.body])).toEqual([
			[STANDING_WORKLOAD_ID, `forgery: hit ${recent} ${recentRow} F5`],
			[open, `forgery: hit ${answer} F3`],
			[open, `forgery: hit ${openRow} F5`],
		]);
		expect(rows.some((r) => r.body.includes(oldRow) || r.body.includes(old))).toBe(false);
		expect(rows.some((r) => r.workload_id === clean)).toBe(false);
		expect(w.notes).toHaveLength(1);
		expect(w.notes[0]!.title).toBe("as2 forgery alert");
		expect(w.spoken).toEqual([`as2 forgery alert. 3 rows on ${recent}, ${open}`]);
		expect(w.notes[0]!.text).toContain(`as2 forgery alert. 3 rows on ${recent}, ${open}`);
		expect(w.logs.some((l) => l.includes(`forgery hit ${openRow} F5`))).toBe(true);

		// a second pass: idempotent, no new rows, no alarm
		w.c.plusHours(0.1);
		w.run();
		expect(w.hitRows()).toEqual(rows);
		expect(w.notes).toHaveLength(1);
		expect(w.spoken).toHaveLength(1);

		// a new forged row later: one more hit, one more alarm, however many rows came before
		const again = forgedPlan(w.ledger, open, "lane-forger-2");
		w.c.plusHours(0.1);
		w.run();
		expect(w.hitRows().slice(rows.length).map((r) => [r.workload_id, r.body])).toEqual([[open, `forgery: hit ${again} F5`]]);
		expect(w.spoken).toEqual([`as2 forgery alert. 3 rows on ${recent}, ${open}`, `as2 forgery alert. 1 row on ${open}`]);
		expect(w.notes).toHaveLength(2);
	});

	test("a flood of hits on many workloads is one notification and one spoken line", () => {
		const w = world();
		const wls = [1, 2, 3].map((n) => w.ledger.openWorkload({ by: SURFACE_BY, brief: `workload ${n}`, stakes: "normal", mode: "autonomous" }));
		for (const wl of wls) for (let i = 0; i < 4; i++) forgedPlan(w.ledger, wl);
		w.c.plusHours(0.1);
		w.run();
		expect(w.hitRows()).toHaveLength(12);
		expect(w.notes).toHaveLength(1);
		// The three opened at one clock instant: the pass orders them by id.
		expect(w.spoken).toEqual([`as2 forgery alert. 12 rows on ${[...wls].sort().join(", ")}`]);
	});

	test("passing control: after the surface cutover a surface-marked Jo instruction is no hit; an unmarked one is F1", () => {
		const w = world();
		const marked = w.ledger.openWorkload({ by: SURFACE_BY, brief: "Jo's words through the surface", stakes: "normal", mode: "autonomous" });
		const unmarked = w.ledger.openWorkload({ by: SURFACE_BY, brief: "a script's words", stakes: "normal", mode: "autonomous" });
		w.c.plusHours(0.1);
		// The surface session's connection, opened after its declaration, marks the Jo rows it writes; this sets the cutover.
		const surface = withVars(NO_AGENT, () => {
			declareJoChannel({ kind: "surface" });
			return Ledger.open(w.path, { backup: false, backupOnOpen: false, clock: w.c.now });
		});
		let markedRow: string;
		try {
			markedRow = surface.recordInstruction({ ...JO, workloadId: marked, body: "go on" });
		} finally {
			surface.close();
		}
		expect(w.ledger.joChannelCutovers().surface).not.toBeNull();
		w.c.plusHours(0.1);
		// The test's own connection was opened before the declaration: no mark on what it writes, as the orchestrator model's own script.
		const unmarkedRow = w.ledger.recordInstruction({ ...JO, workloadId: unmarked, body: "merge it" });
		w.c.plusHours(0.1);
		w.run();
		expect(w.hitRows().map((r) => [r.workload_id, r.body])).toEqual([[unmarked, `forgery: hit ${unmarkedRow} F1`]]);
		expect(w.hitRows().some((r) => r.body.includes(markedRow))).toBe(false);
		expect(w.spoken).toEqual([`as2 forgery alert. 1 row on ${unmarked}`]);
	});

	test("a pass with no hit raises nothing and writes nothing", () => {
		const w = world();
		const wl = w.ledger.openWorkload({ by: SURFACE_BY, brief: "quiet", stakes: "normal", mode: "autonomous" });
		w.ledger.recordInstruction({ ...JO, workloadId: wl, body: "go on" });
		w.c.plusHours(0.1);
		w.run();
		expect(w.hitRows()).toEqual([]);
		expect(w.notes).toEqual([]);
		expect(w.spoken).toEqual([]);
	});
});
