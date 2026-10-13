// The invariant report on the orchestrator's timer (MIGRATION.md item 104; surface/src/invariant-watch.ts):
// a second ctx.setInterval beside the poll, registered once; each finding surfaces once as a needs-you
// line carrying its text and key, again only when its key changes; a skip surfaces only when it holds
// on two runs in a row; the surfaced keys live on the ledger, recorded only once the line is delivered
// (a confirmed push or Jo's turn), so a restart neither re-announces a delivered key nor loses one a
// crash caught between queue and delivery;
// and silent-orchestrator does not read the timer's own records as the orchestrator speaking. The test
// fires the timers (helpers.ts `timers`: [0] the poll, [1] the invariant timer) and replaces the
// session's report with a fixed one, except the last test, which runs the real check over a ledger.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { BACKUP_GAP_MS, check, type Finding, type Invariant, type Report, type Skip } from "../scripts/invariants";
import { ensureStandingWorkload } from "../src/identity";
import { surfacedKeys } from "../src/invariant-watch";
import { surfaceSession } from "../src/session";
import { INVARIANT_MS, INVARIANT_SURFACED_PREFIX, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, type Sent, tempLedger, timeouts, timers, tmp, workloadWithSlice } from "./helpers";

function env(over: Record<string, string> = {}): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const contract = join(tmp("contract"), "output-types.md");
	writeFileSync(contract, "CONTRACT DOC BODY");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, AGENT_SYSTEM_CONTRACT: contract, HOME: "/nonexistent-home", ...over };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

const finding = (key: string, invariant: Invariant = "stuck-question", text = "Question q-1 open 41 min. Answer it or withdraw it."): Finding =>
	({ key, invariant, workload: "wl-a", since: "2026-10-11T18:00:00.000Z", text, query: "SELECT 1" });
const report = (findings: Finding[], skipped: Skip[] = []): Report =>
	({ asOf: "2026-10-11T19:00:00.000Z", replay: false, liveLanes: [], reviewsInFlight: [], orphanReviews: [], findings, skipped, elapsedMs: 1 });

/** An orchestrator surface on a fake host, past its first wake (Jo's turn took it), with the invariant report fixed to `current.report`. */
async function surface(e: Record<string, string> = env()) {
	timers.length = 0;
	timeouts.length = 0;
	const f = fakePi(undefined, { exec: true });
	orchestratorSurface(f.pi, e, {});
	const ctx = ctxOf();
	const current = { report: report([]) };
	const s = surfaceSession(ctx, e);
	s.invariantReport = () => current.report;
	await f.emit("session_start", { type: "session_start" }, ctx);
	await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
	const notices = () => f.sent.filter((x) => x.message.customType === "surface-notices");
	return {
		f, e, ctx, s, current,
		notices,
		/** One invariant tick, then OMP admitting whatever it pushed (so the queue empties as in a live session). */
		tick: async (): Promise<Sent[]> => {
			const before = notices().length;
			timers[1]!.fn();
			const pushed = notices().slice(before);
			for (const m of pushed) await f.admit(m, ctx);
			return pushed;
		},
		/** One invariant tick whose push OMP never confirms (the process dies first). */
		queue: (): Sent[] => {
			const before = notices().length;
			timers[1]!.fn();
			return notices().slice(before);
		},
	};
}

const surfacedIn = (path: string) => {
	const l = Ledger.open(path, { backup: false, backupOnOpen: false });
	try {
		return [...surfacedKeys(l)];
	} finally {
		l.close();
	}
};

describe("the invariant timer (MIGRATION.md item 104)", () => {
	test("registers once per session beside the poll, at 10 min by default and at AGENT_SYSTEM_SURFACE_INVARIANT_MS when set", async () => {
		const a = await surface();
		await a.f.emit("session_start", { type: "session_start" }, a.ctx);
		await a.f.emit("session_compact", { type: "session_compact" }, a.ctx);
		expect(timers.map((t) => t.ms)).toEqual([a.s.pollMs, INVARIANT_MS]);
		expect(INVARIANT_MS).toBe(600_000);

		await surface(env({ AGENT_SYSTEM_SURFACE_INVARIANT_MS: "4321" }));
		expect(timers.map((t) => t.ms)).toEqual([60_000, 4321]);
	});

	test("a lane or hand session registers no invariant timer", async () => {
		timers.length = 0;
		const f = fakePi();
		orchestratorSurface(f.pi, { ...env(), AGENT_SYSTEM_ROLE: "lane" }, {});
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		expect(timers.filter((t) => t.ms === INVARIANT_MS)).toEqual([]);
	});

	test("a finding surfaces once as a needs-you line carrying its text and key, and not again while its key persists", async () => {
		const a = await surface();
		a.current.report = report([finding("stuck-question:q-1")]);
		const first = await a.tick();
		expect(first).toHaveLength(1);
		expect(first[0]!.message.content).toContain("needs you: invariant stuck-question on wl-a since 2026-10-11T18:00:00.000Z: Question q-1 open 41 min. Answer it or withdraw it. (key stuck-question:q-1)");
		expect(first[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
		expect(surfacedIn(a.e.AGENT_SYSTEM_LEDGER_DB!)).toEqual(["stuck-question:q-1"]);

		// The same key on the next two runs: nothing new is pushed or recorded.
		expect(await a.tick()).toEqual([]);
		expect(await a.tick()).toEqual([]);
		expect(a.s.tickNotices).toEqual([]);
		expect(surfacedIn(a.e.AGENT_SYSTEM_LEDGER_DB!)).toEqual(["stuck-question:q-1"]);
	});

	test("a changed key surfaces again; an unchanged one beside it does not", async () => {
		const a = await surface();
		a.current.report = report([finding("ff-lull:abc:en-1", "ff-lull", "behind origin/main by 2; fast-forward at a lull"), finding("stuck-question:q-1")]);
		expect(await a.tick()).toHaveLength(1);
		a.current.report = report([finding("ff-lull:abc:en-2", "ff-lull", "behind origin/main by 2; fast-forward at a lull"), finding("stuck-question:q-1")]);
		const again = await a.tick();
		expect(again).toHaveLength(1);
		expect(again[0]!.message.content).toContain("(key ff-lull:abc:en-2)");
		expect(again[0]!.message.content).not.toContain("stuck-question:q-1");
		expect(surfacedIn(a.e.AGENT_SYSTEM_LEDGER_DB!).sort()).toEqual(["ff-lull:abc:en-1", "ff-lull:abc:en-2", "stuck-question:q-1"]);
	});

	test("checkout-behind-main and process-older-than-head go to Jo as needs-you lines", async () => {
		const a = await surface();
		a.current.report = report([
			finding("checkout-behind-main:aaa:bbb", "checkout-behind-main", "behind origin/main by 3; fast-forward at a lull"),
			finding("process-older-than-head:123:aaa", "process-older-than-head", "pid 123 started before HEAD arrived. Restart it (/exit, then as2)"),
		]);
		const pushed = await a.tick();
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toContain("needs you: invariant checkout-behind-main on wl-a");
		expect(pushed[0]!.message.content).toContain("needs you: invariant process-older-than-head on wl-a");
		expect(pushed[0]!.message.content).toContain("Restart it (/exit, then as2) (key process-older-than-head:123:aaa)");
	});

	test("a skip is not surfaced on one run; one that holds on the next run is, once, grouped by reason; a new reason is told again", async () => {
		const a = await surface();
		const pgrep = "the process table could not be read (pgrep -fl exited 3: boom), so lane liveness is unknown";
		const skips = (reason: string): Skip[] => [{ invariant: "dead-lane", skipped: reason }, { invariant: "silent-lane", skipped: reason }];
		a.current.report = report([], skips(pgrep));
		expect(await a.tick()).toEqual([]);
		// Skipped once, judged once: no persistence.
		a.current.report = report([]);
		expect(await a.tick()).toEqual([]);
		a.current.report = report([], skips(pgrep));
		expect(await a.tick()).toEqual([]);
		// The second run in a row: told, one line for the shared reason, a key per invariant.
		const told = await a.tick();
		expect(told).toHaveLength(1);
		expect(told[0]!.message.content).toContain(`needs you: invariant dead-lane, silent-lane skipped on two runs in a row, so it is not being checked: ${pgrep}`);
		expect(told[0]!.message.content).toContain(`(key skipped:dead-lane:${pgrep}, skipped:silent-lane:${pgrep})`);
		expect(await a.tick()).toEqual([]);
		// A different reason is a different key.
		a.current.report = report([], [{ invariant: "dead-lane", skipped: "pgrep is not available on this machine" }]);
		const changed = await a.tick();
		expect(changed).toHaveLength(1);
		expect(changed[0]!.message.content).toContain("(key skipped:dead-lane:pgrep is not available on this machine)");
	});

	test("a restart does not re-announce keys already surfaced; a new key after the restart is told", async () => {
		const e = env();
		const a = await surface(e);
		a.current.report = report([finding("stuck-question:q-1")]);
		expect(await a.tick()).toHaveLength(1);

		// A new process: a new fake host, a new session context, the same ledger.
		const b = await surface(e);
		expect(b.s).not.toBe(a.s);
		b.current.report = report([finding("stuck-question:q-1")]);
		expect(await b.tick()).toEqual([]);
		b.current.report = report([finding("stuck-question:q-1"), finding("stuck-question:q-2")]);
		const fresh = await b.tick();
		expect(fresh).toHaveLength(1);
		expect(fresh[0]!.message.content).toContain("(key stuck-question:q-2)");
		expect(fresh[0]!.message.content).not.toContain("q-1)");
	});

	test("a key is recorded only on delivery: a crash between queue and confirmation tells the line again after the restart; once confirmed it is not told again", async () => {
		const e = env();
		const a = await surface(e);
		a.current.report = report([finding("stuck-question:q-1")]);
		const queued = a.queue();
		expect(queued).toHaveLength(1);
		// Queued and pushed, not confirmed: nothing on the ledger, and this process does not queue it twice.
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual([]);
		expect(a.queue()).toEqual([]);
		expect(a.s.tickNotices.filter((l) => l.includes("(key stuck-question:q-1)"))).toHaveLength(1);

		// The process dies here. The restart tells it again; this time OMP confirms it.
		const b = await surface(e);
		b.current.report = report([finding("stuck-question:q-1")]);
		const again = b.queue();
		expect(again).toHaveLength(1);
		expect(again[0]!.message.content).toContain("(key stuck-question:q-1)");
		await b.f.admit(again[0]!, b.ctx);
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual(["stuck-question:q-1"]);

		// Confirmed: neither this process nor the next tells it again.
		expect(await b.tick()).toEqual([]);
		const c = await surface(e);
		c.current.report = report([finding("stuck-question:q-1")]);
		expect(await c.tick()).toEqual([]);
	});

	test("a line Jo's turn renders is delivered: its key is recorded then, and not told again", async () => {
		const e = env();
		const a = await surface(e);
		a.current.report = report([finding("stale-backup:ledger-x.db", "stale-backup", "no copy for 31 h")]);
		expect(a.queue()).toHaveLength(1);
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual([]);
		const turn = (await a.f.emit("before_agent_start", { prompt: "status", systemPrompt: [] }, a.ctx)) as { messages: Sent["message"][] };
		expect(turn.messages.map((m) => m.content).join("\n")).toContain("(key stale-backup:ledger-x.db)");
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual(["stale-backup:ledger-x.db"]);
		expect(a.queue()).toEqual([]);
		const b = await surface(e);
		b.current.report = a.current.report;
		expect(b.queue()).toEqual([]);
	});

	test("a line that rode a pushed wake is recorded when the wake is confirmed", async () => {
		const e = env();
		const a = await surface(e);
		a.current.report = report([finding("stuck-question:q-9")]);
		await a.f.emit("session_compact", { type: "session_compact" }, a.ctx);
		// A wake is pending, so the tick's line waits on the queue and rides the wake's push.
		expect(a.queue()).toEqual([]);
		for (const t of timeouts.splice(0)) t.fn();
		const wake = a.f.sent.filter((x) => x.message.customType === "surface-wake").at(-1)!;
		expect(wake.message.content).toContain("(key stuck-question:q-9)");
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual([]);
		await a.f.admit(wake, a.ctx);
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toEqual(["stuck-question:q-9"]);
	});

	test("the surfaced records are the surface's own: a lookalike body by another writer is not a surfaced key", async () => {
		const e = env();
		const l = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
		ensureStandingWorkload(l);
		l.recordEntry({ by: "lane-x", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${INVARIANT_SURFACED_PREFIX} stuck-question:q-1` });
		l.close();
		const a = await surface(e);
		a.current.report = report([finding("stuck-question:q-1")]);
		expect(await a.tick()).toHaveLength(1);
	});

	test("a report that throws is told once per distinct failure, and a later good run clears it", async () => {
		const a = await surface();
		a.s.invariantReport = () => {
			throw new Error("database is locked");
		};
		const failed = await a.tick();
		expect(failed).toHaveLength(1);
		expect(failed[0]!.message.content).toContain("tick: the invariant report failed: Error: database is locked");
		expect(await a.tick()).toEqual([]);
		a.s.invariantReport = () => report([]);
		expect(await a.tick()).toEqual([]);
		a.s.invariantReport = () => {
			throw new Error("database is locked");
		};
		expect(await a.tick()).toHaveLength(1);
	});

	test("a report that throws breaks a skip streak: skip, throw, skip is not two runs in a row; the skip after that is", async () => {
		const a = await surface();
		const reason = "pgrep is not available on this machine";
		const skipped = report([], [{ invariant: "dead-lane", skipped: reason }]);
		a.s.invariantReport = () => skipped;
		expect(await a.tick()).toEqual([]);
		a.s.invariantReport = () => {
			throw new Error("database is locked");
		};
		const failed = await a.tick();
		expect(failed).toHaveLength(1);
		expect(failed[0]!.message.content).toContain("tick: the invariant report failed: Error: database is locked");
		expect(failed[0]!.message.content).not.toContain("skipped on two runs in a row");
		a.s.invariantReport = () => skipped;
		// The run before this one threw, so this skip is the first of a streak, not the second.
		expect(await a.tick()).toEqual([]);
		const told = await a.tick();
		expect(told).toHaveLength(1);
		expect(told[0]!.message.content).toContain(`needs you: invariant dead-lane skipped on two runs in a row, so it is not being checked: ${reason}`);
	});

	test("the default report is the real check over the surface's ledger: a question open past 30 min surfaces with its key", async () => {
		const e = env();
		const l = Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { backup: false, backupOnOpen: false });
		const { wl, sl } = workloadWithSlice(l);
		const q = l.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which header token?", options: ["a", "b"] });
		l.close();
		const a = await surface(e);
		// The fixture replaced this session's report; a fresh session's is the default, over the same ledger, an hour ahead.
		const fresh = surfaceSession(ctxOf(), e);
		fresh.now = () => new Date(Date.now() + 60 * 60_000).toISOString();
		a.s.invariantReport = fresh.invariantReport;
		const pushed = await a.tick();
		expect(pushed).toHaveLength(1);
		expect(pushed[0]!.message.content).toContain(`needs you: invariant stuck-question on ${wl}`);
		expect(pushed[0]!.message.content).toContain(`(key stuck-question:${q})`);
		expect(surfacedIn(e.AGENT_SYSTEM_LEDGER_DB!)).toContain(`stuck-question:${q}`);
	});
});

describe("silent-orchestrator and the timer's own records", () => {
	test("an invariant-surfaced record on the standing workload is not the orchestrator speaking", () => {
		const c = clock("2026-10-11T12:00:00.000Z");
		const { ledger, path } = tempLedger(c.now);
		ensureStandingWorkload(ledger);
		const said = ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "wake-read", body: "resuming" });
		c.plusHours(3);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: `${INVARIANT_SURFACED_PREFIX} stuck-question:q-1` });
		ledger.close();
		const db = new Database(path, { readonly: true });
		try {
			const r = check({
				// Live (not replay): replay would drop a live lane whose lane-started: the ledger lacks.
				db, asOf: c.now(), replay: false, liveLanes: { found: new Set(["wl-a lane-a-1"]) }, lanesDirOf: () => "/nonexistent/lanes",
				repo: "/nonexistent/checkout", git: null, orchestrators: () => ({ skipped: "not run here" }), backups: { dir: tmp("backups"), gapMs: BACKUP_GAP_MS },
			});
			expect(r.findings.filter((f) => f.invariant === "silent-orchestrator").map((f) => f.key)).toEqual([`silent-orchestrator:${said}`]);
		} finally {
			db.close();
		}
	});
});
