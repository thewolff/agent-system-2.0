// The turn-end check (PLAN wl-mv66ylim0gahog § 13.3), through the issues row: a real turn end
// (`agent_end`, `willContinue` false) records a `turns` row per touched workload, pushes those
// workloads first in the tick it starts, and settles each row on the link's `pushed_seq`. GitHub is
// the fake behind the exec seam (`FakeGh`, issues-fakes.ts); the ledger and the sidecar are temp
// files.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import issuesRow, { issuesTickInFlight } from "../extensions/issues";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { Sidecar, sidecarPath } from "../src/issues/sidecar";
import { switchBody } from "../src/issues/switch";
import { trackerEntryBody } from "../src/issues/tracker";
import { markTurnDrift, turnDrift, turnMarkKey } from "../src/issues/turnend";
import { surfaceSession } from "../src/session";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { FakeGh, REPO } from "./issues-fakes";
import { ctxOf, fakePi, timers, tmp } from "./helpers";

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
/** The OMP session ids the fake contexts report (`ctx.sessionManager.getSessionId()`). */
const SESSION_A = "sess-a";
const SESSION_B = "sess-b";

const configText = (perTick: number): string => `issues:\n  trackers:\n    - match: ${REPO}\n      kind: github\n  jo: jo\n  perTick: ${perTick}\n  perHour: 10000\n`;

/**
 * The surface's issues row on a temp ledger and sidecar, the fake GitHub as `pi.exec`, a moving
 * clock. `start()` opens the session (the turn mark); `poll()` fires the row's interval; `turnEnd()`
 * emits `agent_end` and awaits the tick it started.
 */
function setup(o: { rowPhases?: boolean } = {}) {
	let t = T0;
	const ledgerPath = join(tmp("turn-ledger"), "ledger.db");
	const ledger = Ledger.open(ledgerPath, { create: true, backup: false, backupOnOpen: false, clock: () => new Date(t).toISOString() });
	ensureStandingWorkload(ledger);
	const configPath = join(tmp("turn-config"), "config.yml");
	writeFileSync(configPath, configText(100));
	const env = {
		AGENT_SYSTEM_ROLE: "orchestrator",
		AGENT_SYSTEM_LEDGER_DB: ledgerPath,
		AGENT_SYSTEM_ISSUES_CONFIG: configPath,
		AGENT_SYSTEM_SURFACE_POLL_MS: "1234",
		HOME: "/nonexistent-home",
	};
	const gh = new FakeGh();
	const repoDir = tmp("turn-checkout");
	gh.origins.set(repoDir, `https://github.com/${REPO}.git`);
	const f = fakePi();
	Object.assign(f.pi, { exec: gh.exec });
	issuesRow(f.pi, env, o.rowPhases ? { now: () => t } : { now: () => t, phases: {} });
	const ctx = ctxOf();
	Object.assign(ctx.sessionManager, { getSessionId: () => SESSION_A });
	const s = surfaceSession(ctx, env);
	const sidecar = Sidecar.open(sidecarPath(env));
	let switches = 0;
	let poll: (() => void) | null = null;
	const h = {
		ledger,
		sidecar,
		gh,
		s,
		/** This session's turn mark (its own sidecar key): the seq it holds. */
		mark: () => sidecar.state(turnMarkKey(SESSION_A))?.split(" ")[0] ?? null,
		/** A second surface session in this process (its own OMP session id) on the same ledger and sidecar. */
		second: () => {
			const ctx2 = ctxOf();
			Object.assign(ctx2.sessionManager, { getSessionId: () => SESSION_B });
			return {
				start: () => f.emit("session_start", { type: "session_start" }, ctx2),
				shutdown: () => f.emit("session_shutdown", { type: "session_shutdown" }, ctx2),
				mark: () => sidecar.state(turnMarkKey(SESSION_B))?.split(" ")[0] ?? null,
			};
		},
		advance: (ms: number) => {
			t += ms;
		},
		now: () => t,
		setPerTick: (n: number) => writeFileSync(configPath, configText(n)),
		on: () => {
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(true, `in-sw${++switches}`) });
		},
		off: () => {
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: switchBody(false, `in-sw${++switches}`) });
		},
		open: (brief: string): string => {
			t += 1_000;
			const id = ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });
			recordRepo(ledger, id, repoDir);
			return id;
		},
		/** A slice entry on `id` (Ilex acting on the workload); its provenance seq. */
		act: (id: string): number => {
			t += 1_000;
			ledger.recordEntry({ by: SURFACE_BY, workloadId: id, kind: "assumption", body: "a decision" });
			return h.maxSeq(id);
		},
		maxSeq: (id: string): number => ledger.db.query<{ m: number }, [string]>("SELECT max(seq) AS m FROM provenance WHERE workload_id = ?").get(id)!.m,
		start: async () => {
			timers.length = 0;
			await f.emit("session_start", { type: "session_start" }, ctx);
			poll = timers[0]!.fn;
		},
		poll: async () => {
			t += 1_000;
			poll!();
			await issuesTickInFlight(s);
		},
		turnEnd: async (willContinue = false) => {
			t += 1_000;
			await f.emit("agent_end", { willContinue }, ctx);
			await issuesTickInFlight(s);
		},
		jo: (prompt: string) => f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx),
		turnRows: () => sidecar.turns(),
		/** On, two workloads, the session started, both issues created by one poll; the calls cleared. */
		twoPushed: async () => {
			h.on();
			const a = h.open("workload A");
			const b = h.open("workload B");
			await h.start();
			await h.poll();
			const na = sidecar.link(a)?.issue_number;
			const nb = sidecar.link(b)?.issue_number;
			if (!na || !nb) throw new Error(`issues not created: ${s.tickNotices.join("; ")}`);
			gh.calls.length = 0;
			return { a, b, na, nb };
		},
		turnNotices: () => s.tickNotices.filter((l) => l.includes("not updated after turn")),
		shutdown: () => f.emit("session_shutdown", { type: "session_shutdown" }, ctx),
	};
	return h;
}

describe("the turn-end check (§ 13.3)", () => {
	afterEach(() => {
		timers.length = 0;
	});

	test("a turn that records an entry on wl-A pushes A first in the next tick, advances pushed_seq, and settles its row updated", async () => {
		const h = setup();
		const { a, b, na, nb } = await h.twoPushed();
		// B is dirty and older (the reconciler marked it): by `last_seq` alone it would go first.
		h.sidecar.db.query("UPDATE links SET dirty = 1, force = 1 WHERE workload_id = ?").run(b);
		await h.jo("do the thing on A");
		const seq = h.act(a);
		await h.turnEnd();
		const views = h.gh.made("issue view").map((c) => Number(c[2]));
		expect(views).toEqual([na, nb]);
		expect(h.sidecar.link(a)).toMatchObject({ pushed_seq: seq, dirty: 0, priority: 0 });
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "updated" })]);
		await h.shutdown();
	});

	test("one turn touching A then B: each row carries its workload's own seq and both settle updated after their pushes", async () => {
		const h = setup();
		const { a, b } = await h.twoPushed();
		const seqA = h.act(a);
		const seqB = h.act(b);
		expect(seqB).toBeGreaterThan(seqA);
		await h.turnEnd();
		const rows = h.turnRows();
		expect(rows.map((r) => [r.workload_id, r.seq, r.outcome])).toEqual([
			[a, seqA, "updated"],
			[b, seqB, "updated"],
		]);
		expect(h.sidecar.link(a)?.pushed_seq).toBe(seqA);
		expect(h.sidecar.link(b)?.pushed_seq).toBe(seqB);
		expect(h.mark()).toBe(String(seqB));
		await h.shutdown();
	});

	test("a turn whose only write is an input-row command (`tracker …`) is covered", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		// What the surface's input path writes before the turn's before_agent_start: Jo's input row on
		// wl-orchestrator, then the instruction and the `tracker:` entry on the workload.
		const input = h.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `tracker ${a} github`, author: "jo", channel: "surface" });
		h.ledger.recordInstruction({ by: SURFACE_BY, workloadId: a, body: `tracker ${a} github`, author: "jo", channel: "surface" });
		h.ledger.recordEntry({ by: SURFACE_BY, workloadId: a, kind: "assumption", body: trackerEntryBody(a, { kind: "github" }, input) });
		await h.jo(`tracker ${a} github`);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq: h.maxSeq(a), outcome: "updated" })]);
		await h.shutdown();
	});

	test("an aside-started turn (no before_agent_start) is covered", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		const seq = h.act(a);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "updated" })]);
		expect(h.sidecar.link(a)?.pushed_seq).toBe(seq);
		await h.shutdown();
	});

	test("a no-diff push writes the receipt and settles updated", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		const seq = h.act(a);
		// A poll inside the turn pushed the write already; the link's receipt is gone (a link pushed
		// before § 13 has no pushed_seq), so only a push can settle the turn.
		await h.poll();
		h.sidecar.db.query("UPDATE links SET pushed_seq = NULL WHERE workload_id = ?").run(a);
		h.gh.calls.length = 0;
		await h.turnEnd();
		expect(h.gh.made("issue view")).toEqual([]);
		expect(h.gh.made("issue edit")).toEqual([]);
		expect(h.sidecar.link(a)).toMatchObject({ pushed_seq: seq, dirty: 0 });
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "updated" })]);
		await h.shutdown();
	});

	test("budget out leaves the row pending until a tick has the budget", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		h.setPerTick(1);
		const seq = h.act(a);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "pending", ticks: 1 })]);
		expect(h.sidecar.link(a)).toMatchObject({ dirty: 1, priority: 1 });
		expect(h.sidecar.link(a)!.pushed_seq).toBeLessThan(seq);
		await h.poll();
		const row = h.turnRows()[0]!;
		expect(row).toMatchObject({ outcome: "pending", ticks: 2, reason: "budget" });
		expect(h.turnNotices()).toEqual([`tick: issues: issue for ${a} not updated after turn ${new Date(row.turn_end_at).toISOString()}: budget`]);
		h.setPerTick(100);
		await h.poll();
		expect(h.turnRows()[0]).toMatchObject({ outcome: "updated" });
		expect(h.sidecar.link(a)).toMatchObject({ pushed_seq: seq, priority: 0 });
		await h.shutdown();
	});

	test("backoff leaves the row pending until the link's next try succeeds", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		h.gh.fail = (args) => args[0] === "issue" && args[1] === "view";
		const seq = h.act(a);
		await h.turnEnd();
		expect(h.sidecar.link(a)).toMatchObject({ fails: 1, dirty: 1 });
		expect(h.turnRows()[0]).toMatchObject({ outcome: "pending", ticks: 1 });
		h.gh.fail = () => false;
		h.gh.calls.length = 0;
		await h.poll();
		// Still inside the backoff: no push was tried.
		expect(h.gh.made("issue view")).toEqual([]);
		expect(h.turnRows()[0]).toMatchObject({ outcome: "pending", ticks: 2 });
		h.advance(10 * 60_000);
		await h.poll();
		expect(h.turnRows()[0]).toMatchObject({ outcome: "updated" });
		expect(h.sidecar.link(a)?.pushed_seq).toBe(seq);
		await h.shutdown();
	});

	test("a turn touching only wl-orchestrator records no row", async () => {
		const h = setup();
		await h.twoPushed();
		h.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: "standing note" });
		await h.turnEnd();
		expect(h.turnRows()).toEqual([]);
		expect(h.mark()).toBe(String(h.maxSeq(STANDING_WORKLOAD_ID)));
		expect(h.gh.made("issue view")).toEqual([]);
		await h.shutdown();
	});

	test("switch off: the row is not-projected at once and the turn makes zero calls", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		h.off();
		const seq = h.act(a);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "not-projected", ticks: 0 })]);
		expect(h.gh.calls).toEqual([]);
		expect(h.sidecar.link(a)?.priority).toBe(0);
		await h.shutdown();
	});

	test("a failing tracker: one notice after two ticks, no second", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		h.gh.fail = (args) => args[0] === "issue";
		h.act(a);
		await h.turnEnd();
		expect(h.turnNotices()).toEqual([]);
		await h.poll();
		const row = h.turnRows()[0]!;
		expect(row).toMatchObject({ outcome: "pending", ticks: 2, noticed: 1 });
		expect(h.turnNotices()).toEqual([`tick: issues: issue for ${a} not updated after turn ${new Date(row.turn_end_at).toISOString()}: backoff after 1 failed push`]);
		for (let i = 0; i < 3; i++) {
			h.advance(10 * 60_000);
			await h.poll();
		}
		expect(h.turnRows()[0]).toMatchObject({ outcome: "pending", noticed: 1 });
		expect(h.turnRows()[0]!.ticks).toBe(5);
		expect(h.turnNotices()).toHaveLength(1);
		// One line in the next drift entry: read without consuming, gone once marked carried.
		const line = `turn ${new Date(row.turn_end_at).toISOString()}: ${a} not updated (backoff after 1 failed push)`;
		expect(turnDrift(h.sidecar)).toEqual({ ids: [row.id], lines: [line] });
		expect(turnDrift(h.sidecar).lines).toEqual([line]);
		h.sidecar.immediate(() => markTurnDrift(h.sidecar, [row.id]));
		expect(turnDrift(h.sidecar)).toEqual({ ids: [], lines: [] });
		await h.shutdown();
	});

	test("willContinue true records nothing and starts no tick until the real end", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		const before = issuesTickInFlight(h.s);
		const mark = h.mark();
		const seq = h.act(a);
		await h.turnEnd(true);
		expect(issuesTickInFlight(h.s)).toBe(before);
		expect(h.turnRows()).toEqual([]);
		expect(h.mark()).toBe(mark);
		expect(h.gh.calls).toEqual([]);
		await h.turnEnd(false);
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "updated" })]);
		await h.shutdown();
	});

	test("a second surface session starting mid-turn leaves the first session's range whole; each shutdown deletes only its own mark", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		// Session A's turn writes on wl-A, then session B starts before A's turn ends.
		const seq = h.act(a);
		const b = h.second();
		await b.start();
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq, outcome: "updated" })]);
		expect(h.sidecar.link(a)?.pushed_seq).toBe(seq);
		expect(h.mark()).toBe(String(seq));
		expect(b.mark()).toBe(String(seq));
		await b.shutdown();
		expect(b.mark()).toBeNull();
		expect(h.mark()).toBe(String(seq));
		await h.shutdown();
		expect(h.mark()).toBeNull();
	});

	test("a session start deletes turn marks older than 7 days, a bare seq (the old form) among them; a mark is `<seq> <iso>`, and a bare one still reads as its seq", async () => {
		const h = setup();
		const DAY = 24 * 60 * 60_000;
		h.sidecar.immediate(() => {
			h.sidecar.setState(turnMarkKey("crashed-old"), `3 ${new Date(T0 - 8 * DAY).toISOString()}`);
			h.sidecar.setState(turnMarkKey("crashed-recent"), `3 ${new Date(T0 - DAY).toISOString()}`);
			h.sidecar.setState(turnMarkKey("crashed-legacy"), "3");
		});
		h.on();
		const a = h.open("workload A");
		await h.start();
		const top = () => h.ledger.db.query<{ m: number }, []>("SELECT max(seq) AS m FROM provenance").get()!.m;
		expect(h.sidecar.state(turnMarkKey("crashed-old"))).toBeNull();
		expect(h.sidecar.state(turnMarkKey("crashed-legacy"))).toBeNull();
		expect(h.sidecar.state(turnMarkKey("crashed-recent"))).toBe(`3 ${new Date(T0 - DAY).toISOString()}`);
		expect(h.sidecar.state(turnMarkKey(SESSION_A))).toBe(`${top()} ${new Date(h.now()).toISOString()}`);

		// A mark the previous version wrote (a bare seq) still bounds the session's next range.
		h.sidecar.immediate(() => h.sidecar.setState(turnMarkKey(SESSION_A), String(top())));
		const seq = h.act(a);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq })]);
		expect(h.sidecar.state(turnMarkKey(SESSION_A))).toBe(`${seq} ${new Date(h.now()).toISOString()}`);
		await h.shutdown();
	});

	test("a live session idle for more than 7 days keeps its mark while its polls run: another session's start leaves it, and its next turn's range is whole", async () => {
		const h = setup();
		const { a } = await h.twoPushed();
		const DAY = 24 * 60 * 60_000;
		const seq = h.act(a);
		const top = h.mark();
		// Eight idle days, the row's poll firing through them: no turn end, so the seq stays.
		for (let d = 0; d < 8; d++) {
			h.advance(DAY);
			await h.poll();
		}
		expect(h.mark()).toBe(top);
		expect(h.sidecar.state(turnMarkKey(SESSION_A))).toBe(`${top} ${new Date(h.now()).toISOString()}`);
		const b = h.second();
		await b.start();
		expect(h.mark()).toBe(top);
		await h.turnEnd();
		expect(h.turnRows()).toEqual([expect.objectContaining({ workload_id: a, seq })]);
		await b.shutdown();
		await h.shutdown();
	});
});

describe("the row's phases", () => {
	afterEach(() => {
		timers.length = 0;
	});

	test("intake runs from the row by default, on its intakeEveryMin cadence", async () => {
		const h = setup({ rowPhases: true });
		const graphql = () => h.gh.calls.filter((c) => c[0] === "api" && c[1] === "graphql").length;
		h.on();
		await h.start();
		await h.poll();
		expect(graphql()).toBe(1);
		await h.poll();
		h.advance(4 * 60_000);
		await h.poll();
		expect(graphql()).toBe(1);
		h.advance(60_000);
		await h.poll();
		expect(graphql()).toBe(2);
		await h.shutdown();
	});
});
