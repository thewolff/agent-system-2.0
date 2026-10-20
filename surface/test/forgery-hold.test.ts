// The forgery hold (PLAN wl-mvfxw3c4zqfzls D3, D4; R11-R14): a workload with a recorded `forgery:` hit Jo has answered
// neither way is not launched autonomously (`launchable` → forgery-hold), its live autonomous lane gets the check's stop
// request (a by-hand lane gets none), the merge train refuses to board it (`landingReady`, `boardLanding`), and the close is
// refused; Jo's `forgery-confirmed:` lifts each, and a `forgery-reversed:` after the close keeps the train's refusal (D5). The launch reserve (surface/scripts/lane.ts `reserve`) runs the check itself
// and refuses on a hit no pass recorded yet, writing the hit rows and raising one alarm; the needs-you line is LOUD until Jo
// answers; `merge-train.ts stakes --hold-ok` (the real script, a fake gh on PATH) answers `hold: forgery <row id>` for a hit
// recorded or not. Every forged row is a real ledger row: a lane-written jo-only prefix (F5), a lane-stamped answer (F3).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { declareJoChannel, forgeryReversedBody, JO_CHANNEL_LANE } from "../../ledger/src/jo-channel";
import { LEDGER_DB_ENV } from "../../ledger/src/locality";
import { closeWorkloadWithEntry } from "../extensions/workload";
import * as laneScript from "../scripts/lane";
import { errorLines } from "../src/errors";
import { consequences, forgeryHoldLine, forgeryPass, forgeryStakesHold, unansweredHits } from "../src/forgery-hold";
import { ensureStandingWorkload } from "../src/identity";
import { apply, interpret } from "../src/input";
import { controlEntries, forgeryConfirmedBody, holdersOf, launchable, launchRequestedBody, pendingStop, planApprovedBody, verdictOf } from "../src/launch";
import { AUTOBOARD_WINDOW_MS, boardLanding, landingReady } from "../src/merge-train";
import type { RankConfig } from "../src/rank-launch";
import { FORGERY_CHECK_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, fakePi, tempLedger, tmp } from "./helpers";
import { boardWorld, SERVED } from "./train-world";

const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
const SHOW: RankConfig = { mode: "show", parallelBudgetUsd: 0 };
const CLI = resolve(import.meta.dir, "..", "scripts", "merge-train.ts");
const NO_AGENT = { AGENT_SYSTEM_ROLE: undefined, AGENT_SYSTEM_LANE_ID: undefined, AGENT_SYSTEM_WORKLOAD_ID: undefined };

/** Run `fn` with `vars` set (undefined clears one) in process.env, then restore them. */
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

function world() {
	const c = clock();
	const { ledger, path } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	return { c, ledger, path };
}

/** A lane-written `plan: approved …` on `wl`: a jo-only prefix whose writer the prefix refuses (F5). Its entry id. */
const forgedPlan = (ledger: Ledger, wl: string, lane = "lane-forger-1") =>
	ledger.recordEntry({ by: lane, workloadId: wl, kind: "assumption", body: planApprovedBody("in-nothing") });

/**
 * A surface session's connection to `path`: the process declared a Jo channel before it opens, so it marks every Jo row it
 * writes (its first mark sets the surface cutover). A connection opened before the declaration (the test's `ledger`) marks none.
 */
function surfaceOf(path: string, now: () => string): Ledger {
	return withVars(NO_AGENT, () => {
		declareJoChannel({ kind: "surface" });
		return Ledger.open(path, { backup: false, backupOnOpen: false, clock: now });
	});
}

/**
 * Jo's `confirm <row id>` as the surface records it: his words, then `forgery-confirmed:` on `on` (the workload, or the standing one
 * once closed). Written through `via`: the surface's connection writes Jo's answer; the test's unmarked one, a forged answer.
 */
function confirm(via: Ledger, on: string, rowId: string): string {
	const words = via.recordInstruction({ ...JO, workloadId: on, body: `confirm ${rowId}` });
	return via.recordEntry({ by: SURFACE_BY, workloadId: on, kind: "assumption", body: forgeryConfirmedBody(rowId, words) });
}
/** Jo's `reverse <row id>`, the same way. */
function reverse(via: Ledger, on: string, rowId: string): string {
	const words = via.recordInstruction({ ...JO, workloadId: on, body: `reverse ${rowId}` });
	return via.recordEntry({ by: SURFACE_BY, workloadId: on, kind: "assumption", body: forgeryReversedBody(rowId, words) });
}

/** `launchable` over `wl` as the ledger stands, with the workload's surface-marked entries (the marks a launch reads). */
function verdict(ledger: Ledger, wl: string) {
	const w = ledger.workload(wl)!;
	const entries = ledger.entries(wl);
	const marked = new Set(ledger.provenance(wl).filter((p) => p.lane_instance === JO_CHANNEL_LANE && p.tbl === "entries" && p.detail === "surface").map((p) => p.row_id));
	return launchable(w, controlEntries(entries, holdersOf(entries, w.holder, ledger.holders(wl))), null, [], ledger.now(), 0, 10, marked);
}

describe("R11: an unanswered hit holds the workload", () => {
	test("launchable answers forgery-hold; the live autonomous lane gets the check's stop request, a by-hand lane none; confirm lifts it", () => {
		const { c, ledger, path } = world();
		const auto = ledger.openWorkload({ by: SURFACE_BY, brief: "an autonomous workload", stakes: "normal", mode: "autonomous" });
		c.plusHours(0.01);
		const byHand = ledger.openWorkload({ by: SURFACE_BY, brief: "Jo's own workload", stakes: "normal", mode: "user-driven" });
		const autoLane = "lane-auto-1";
		const handLane = "lane-hand-1";
		expect(ledger.claimWorkload(auto, { by: LANE_STARTER_BY, holder: autoLane, leaseMs: 600_000 }).won).toBe(true);
		expect(ledger.claimWorkload(byHand, { by: LANE_STARTER_BY, holder: handLane, leaseMs: 600_000 }).won).toBe(true);
		// F3: the lane answers its own question
		const sl = ledger.addSlice({ by: autoLane, workloadId: auto, task: "t", doneCondition: "d", inputs: "i" });
		const q = ledger.raiseQuestion({ by: autoLane, workloadId: auto, sliceId: sl, body: "Ship it?", options: ["yes", "no"] });
		const answer = ledger.answerQuestion(q, { by: autoLane, answer: "yes", author: "jo", channel: "surface" });
		const handRow = forgedPlan(ledger, byHand, handLane);
		c.plusHours(0.1);

		const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
		expect(pass.hits.map((h) => [h.workloadId, h.rowId])).toEqual([[auto, answer], [byHand, handRow]]);
		expect(pass.hits.find((h) => h.rowId === answer)!.rule).toMatch(/^F[23]$/);
		expect(pass.stops.map((s) => [s.workloadId, s.laneId])).toEqual([[auto, autoLane]]);
		const control = (wl: string) => {
			const es = ledger.entries(wl);
			return controlEntries(es, holdersOf(es, ledger.workload(wl)!.holder, ledger.holders(wl)));
		};
		// the runner honours it as it honours `as2 lane stop`
		expect(pendingStop(control(auto), autoLane)).toMatchObject({ reason: "forgery-hold", by: FORGERY_CHECK_BY });
		expect(pendingStop(control(byHand), handLane)).toBeNull();
		// a second pass asks no second stop
		expect(forgeryPass(ledger, AUTOBOARD_WINDOW_MS)).toEqual({ hits: [], stops: [] });

		// once the lanes are gone: no autonomous launch while held
		ledger.releaseWorkload(auto, { by: LANE_STARTER_BY, holder: autoLane });
		ledger.releaseWorkload(byHand, { by: LANE_STARTER_BY, holder: handLane });
		expect(verdict(ledger, auto)).toEqual({ launch: false, reason: "forgery-hold" });
		const refused = laneScript.reserve(ledger, auto, "test", false, SHOW);
		expect(refused).toEqual({ ok: false, reason: "forgery-hold" });
		// by hand is not refused: Jo's own terminal, told by the hold line
		expect(forgeryHoldLine(ledger, byHand)).toContain(`forgery hold on ${byHand}: 1 flagged row Jo has not answered (${handRow} F5)`);
		const hand = laneScript.reserve(ledger, byHand, "jo", true, SHOW);
		expect(hand.ok).toBe(true);

		const surface = surfaceOf(path, c.now);
		confirm(surface, auto, answer);
		expect(unansweredHits(ledger, auto)).toEqual([]);
		expect(forgeryHoldLine(ledger, auto)).toBeNull();
		expect(verdict(ledger, auto)).toMatchObject({ launch: true });
		expect(laneScript.reserve(ledger, auto, "test", false, SHOW).ok).toBe(true);
	});

	test("landingReady and boardLanding refuse a closed workload whose hit sits on the standing workload; confirm there lifts both", () => {
		const w = boardWorld();
		// The landing's lane forges a jo-only row just before the close.
		let forged = "";
		const close = w.ledger.closeWorkload.bind(w.ledger);
		w.ledger.closeWorkload = ((id: string, s: { by: string }) => {
			forged = forgedPlan(w.ledger, id);
			return close(id, s);
		}) as typeof w.ledger.closeWorkload;
		const wl = w.landing(117);
		w.ledger.closeWorkload = close;
		const CTX = { config: SERVED };
		const before = landingReady(w.ledger, wl, CTX);
		expect(before.ready).toBe(true);
		if (!before.ready) return;

		const pass = forgeryPass(w.ledger, AUTOBOARD_WINDOW_MS);
		expect(pass.hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[wl, forged, "F5"]]);
		expect(w.ledger.entry(pass.hits[0]!.entryId)!.workload_id).toBe(STANDING_WORKLOAD_ID);
		expect(unansweredHits(w.ledger, wl).map((h) => [h.rowId, h.on])).toEqual([[forged, STANDING_WORKLOAD_ID]]);
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: `forgery hold: ${forged} F5 unanswered` });
		expect(boardLanding(w.ledger, before)).toEqual({ boarded: false, reason: `forgery hold on ${wl}: ${forged} unanswered` });

		// Jo's answer to a closed workload's row sits on the standing workload
		confirm(surfaceOf(w.ledger.path, w.c.now), STANDING_WORKLOAD_ID, forged);
		const after = landingReady(w.ledger, wl, CTX);
		expect(after.ready).toBe(true);
		if (!after.ready) return;
		expect(boardLanding(w.ledger, after)).toMatchObject({ boarded: true });
	});

	test("the close is refused while a recorded hit is unanswered, and not for that once Jo confirms", async () => {
		const { c, ledger, path } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "a workload to close", stakes: "normal", mode: "autonomous" });
		const row = forgedPlan(ledger, wl);
		c.plusHours(0.1);
		forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
		const cwd = tmp("forgery-close");
		const pi = fakePi().pi;
		const held = await closeWorkloadWithEntry(pi, ledger, {}, wl, { now: c.now(), cwd, receipt: null });
		expect(held.closed).toBe(false);
		expect(held.text).toBe(`${wl} cannot close: forgery hold on ${wl}: 1 flagged row Jo has not answered (${row} F5); at the surface: confirm ${row} (it was Jo's) / reverse ${row} (it was not)`);
		confirm(surfaceOf(path, c.now), wl, row);
		const lifted = await closeWorkloadWithEntry(pi, ledger, {}, wl, { now: c.now(), cwd, receipt: null });
		expect(lifted.text).not.toContain("forgery hold");
	});

	test("a forged confirmation lifts no hold: a self-confirmation, and a cycle of two, stay held until Jo answers", () => {
		const { c, ledger, path } = world();
		const self = ledger.openWorkload({ by: SURFACE_BY, brief: "a self-confirmation", stakes: "normal", mode: "autonomous" });
		c.plusHours(0.01);
		const cycle = ledger.openWorkload({ by: SURFACE_BY, brief: "a confirmation cycle", stakes: "normal", mode: "autonomous" });
		c.plusHours(0.01);
		// The surface session's connection, opened after its declaration, marks the Jo rows it writes; this sets the cutover.
		const surface = surfaceOf(path, c.now);
		try {
			surface.recordInstruction({ ...JO, workloadId: self, body: "go on" });
			expect(ledger.joChannelCutovers().surface).not.toBeNull();
			c.plusHours(0.01);
			// A script on the test's unmarked connection forges surface-stamped confirmations by direct insert, choosing their ids.
			const forge = (wl: string, id: string, rowId: string) =>
				ledger.db.query("INSERT INTO entries (id, workload_id, slice_id, kind, body, created_by, created_at) VALUES (?, ?, NULL, 'assumption', ?, ?, ?)")
					.run(id, wl, forgeryConfirmedBody(rowId, "in-forged"), SURFACE_BY, ledger.now());
			forge(self, "en-forgedself", "en-forgedself");
			forge(cycle, "en-forgedcyclea", "en-forgedcycleb");
			forge(cycle, "en-forgedcycleb", "en-forgedcyclea");
			c.plusHours(0.1);

			// before any pass, the check's own hits hold both
			expect(forgeryHoldLine(ledger, self)).toContain("en-forgedself F1");
			expect(forgeryHoldLine(ledger, cycle)).toContain("en-forgedcyclea F1");
			const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
			expect(pass.hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([
				[self, "en-forgedself", "F1"], [cycle, "en-forgedcyclea", "F1"], [cycle, "en-forgedcycleb", "F1"],
			]);
			expect(unansweredHits(ledger, self).map((h) => h.rowId)).toEqual(["en-forgedself"]);
			expect(unansweredHits(ledger, cycle).map((h) => h.rowId).sort()).toEqual(["en-forgedcyclea", "en-forgedcycleb"]);
			expect(verdict(ledger, self)).toEqual({ launch: false, reason: "forgery-hold" });
			expect(verdict(ledger, cycle)).toEqual({ launch: false, reason: "forgery-hold" });

			// Jo's own marked confirmation of one cycle member clears that member's hit only: no chain runs through it to the other
			confirm(surface, cycle, "en-forgedcyclea");
			expect(unansweredHits(ledger, cycle).map((h) => h.rowId)).toEqual(["en-forgedcycleb"]);
			expect(forgeryHoldLine(ledger, cycle, { fresh: false })).toContain("en-forgedcycleb F1");
			expect(verdict(ledger, cycle)).toEqual({ launch: false, reason: "forgery-hold" });
			confirm(surface, cycle, "en-forgedcycleb");
			expect(unansweredHits(ledger, cycle)).toEqual([]);
			expect(forgeryHoldLine(ledger, cycle)).toBeNull();
			expect(verdict(ledger, cycle)).toMatchObject({ launch: true });
			expect(verdict(ledger, self)).toEqual({ launch: false, reason: "forgery-hold" });
		} finally {
			surface.close();
		}
	});

	test("an unmarked confirmation written after the hit was recorded lifts nothing: unansweredHits, the close's hold line and launchable stay held; Jo's marked one lifts", async () => {
		const { c, ledger, path } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "held by a recorded hit", stakes: "normal", mode: "autonomous" });
		const surface = surfaceOf(path, c.now);
		try {
			surface.recordInstruction({ ...JO, workloadId: wl, body: "go on" });
			c.plusHours(0.01);
			const row = forgedPlan(ledger, wl);
			c.plusHours(0.1);
			expect(forgeryPass(ledger, AUTOBOARD_WINDOW_MS).hits.map((h) => [h.rowId, h.rule])).toEqual([[row, "F5"]]);
			// A script on the test's unmarked connection writes a surface-stamped confirmation of the recorded hit; no pass has run since.
			const forged = confirm(ledger, wl, row);
			expect(unansweredHits(ledger, wl).map((h) => h.rowId)).toEqual([row]);
			expect(forgeryHoldLine(ledger, wl, { fresh: false })).toContain(`(${row} F5)`);
			expect(verdict(ledger, wl)).toEqual({ launch: false, reason: "forgery-hold" });
			expect(verdictOf(ledger.launchRows(wl, 10)!)).toEqual({ launch: false, reason: "forgery-hold" });
			const cwd = tmp("forgery-forged-confirm");
			const pi = fakePi().pi;
			const held = await closeWorkloadWithEntry(pi, ledger, {}, wl, { now: c.now(), cwd, receipt: null });
			expect(held.closed).toBe(false);
			expect(held.text).toContain(`${wl} cannot close: forgery hold on ${wl}: 1 flagged row Jo has not answered (${row} F5)`);
			// the forged confirmation is no answer for Jo's real word either: `reverse` is not refused as already answered
			expect(interpret(surface, `reverse ${row}`, () => null)).toEqual({ kind: "forgery-reverse", workloadId: wl, on: wl, rowId: row });
			expect(forged).not.toBe(row);

			confirm(surface, wl, row);
			expect(unansweredHits(ledger, wl)).toEqual([]);
			expect(forgeryHoldLine(ledger, wl, { fresh: false })).toBeNull();
			expect(verdict(ledger, wl)).toMatchObject({ launch: true });
			expect(verdictOf(ledger.launchRows(wl, 10)!)).toMatchObject({ launch: true });
		} finally {
			surface.close();
		}
	});

	test("a closed workload's recorded hit: an unmarked confirmation on the standing workload keeps landingReady, boardLanding and stakes held; Jo's marked one lifts", () => {
		const w = boardWorld();
		const surface = surfaceOf(w.ledger.path, w.c.now);
		try {
			let forged = "";
			const close = w.ledger.closeWorkload.bind(w.ledger);
			w.ledger.closeWorkload = ((id: string, s: { by: string }) => {
				forged = forgedPlan(w.ledger, id);
				return close(id, s);
			}) as typeof w.ledger.closeWorkload;
			const wl = w.landing(118);
			w.ledger.closeWorkload = close;
			const CTX = { config: SERVED };
			const before = landingReady(w.ledger, wl, CTX);
			expect(before.ready).toBe(true);
			if (!before.ready) return;
			expect(forgeryPass(w.ledger, AUTOBOARD_WINDOW_MS).hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[wl, forged, "F5"]]);

			// A script's unmarked confirmation on the standing workload, where a closed workload's answer sits; no pass has run since.
			confirm(w.ledger, STANDING_WORKLOAD_ID, forged);
			expect(unansweredHits(w.ledger, wl).map((h) => h.rowId)).toEqual([forged]);
			expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: `forgery hold: ${forged} F5 unanswered` });
			expect(boardLanding(w.ledger, before)).toEqual({ boarded: false, reason: `forgery hold on ${wl}: ${forged} unanswered` });
			expect(forgeryStakesHold(w.ledger, [wl])).toBe(`hold: forgery ${forged} F5 on ${wl}`);

			confirm(surface, STANDING_WORKLOAD_ID, forged);
			expect(unansweredHits(w.ledger, wl)).toEqual([]);
			expect(forgeryStakesHold(w.ledger, [wl])).toBeNull();
			const after = landingReady(w.ledger, wl, CTX);
			expect(after.ready).toBe(true);
			if (!after.ready) return;
			expect(boardLanding(w.ledger, after)).toMatchObject({ boarded: true });
		} finally {
			surface.close();
		}
	});

	test("an unmarked reversal naming the recorded hit entry hides nothing: unansweredHits, the hold line, the close, launchable, the LOUD line and Jo's reverse keep the hit; Jo's marked confirm lifts; the pass flags the forged reversal", async () => {
		const { c, ledger, path } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "held by a recorded hit", stakes: "normal", mode: "autonomous" });
		const surface = surfaceOf(path, c.now);
		try {
			surface.recordInstruction({ ...JO, workloadId: wl, body: "go on" });
			expect(ledger.joChannelCutovers().surface).not.toBeNull();
			c.plusHours(0.01);
			// A script on the test's unmarked connection writes a Jo instruction after the cutover (F1); a pass records its hit.
			const row = ledger.recordInstruction({ ...JO, workloadId: wl, body: "ship it" });
			c.plusHours(0.1);
			const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
			expect(pass.hits.map((h) => [h.rowId, h.rule])).toEqual([[row, "F1"]]);
			const hitEntry = pass.hits[0]!.entryId;
			c.plusHours(0.01);
			// The script then writes a surface-stamped reversal of the check's hit entry itself, not of the flagged row.
			const forged = ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: forgeryReversedBody(hitEntry, "in-forged") });
			expect(unansweredHits(ledger, wl).map((h) => [h.rowId, h.entryId])).toEqual([[row, hitEntry]]);
			expect(forgeryHoldLine(ledger, wl, { fresh: false })).toContain(`(${row} F1)`);
			expect(verdict(ledger, wl)).toEqual({ launch: false, reason: "forgery-hold" });
			expect(verdictOf(ledger.launchRows(wl, 10)!)).toEqual({ launch: false, reason: "forgery-hold" });
			expect(errorLines(ledger).filter((l) => l.kind === "forgery").map((l) => [l.workloadId, l.rowId])).toEqual([[wl, row]]);
			const cwd = tmp("forgery-forged-hit-reversal");
			const pi = fakePi().pi;
			const held = await closeWorkloadWithEntry(pi, ledger, {}, wl, { now: c.now(), cwd, receipt: null });
			expect(held.closed).toBe(false);
			expect(held.text).toContain(`${wl} cannot close: forgery hold on ${wl}: 1 flagged row Jo has not answered (${row} F1)`);
			// Jo's real word still finds the hit; the check's hit entry is no flagged row, so `reverse` refuses it
			expect(interpret(surface, `reverse ${row}`, () => null)).toEqual({ kind: "forgery-reverse", workloadId: wl, on: wl, rowId: row });
			expect(interpret(surface, `reverse ${hitEntry}`, () => null)).toEqual({
				kind: "refused", why: `no recorded forgery hit names ${hitEntry}: \`reverse <row id>\` answers a flagged row on the needs-you list`,
			});

			confirm(surface, wl, row);
			expect(unansweredHits(ledger, wl)).toEqual([]);
			expect(forgeryHoldLine(ledger, wl, { fresh: false })).toBeNull();
			expect(verdict(ledger, wl)).toMatchObject({ launch: true });
			// the forged reversal is itself an unmarked jo-only entry: the next pass flags it
			expect(forgeryPass(ledger, AUTOBOARD_WINDOW_MS).hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[wl, forged, "F1"]]);
			expect(unansweredHits(ledger, wl).map((h) => h.rowId)).toEqual([forged]);
		} finally {
			surface.close();
		}
	});

	test("a closed workload's recorded hit: an unmarked reversal naming the hit entry on the standing workload hides nothing: landingReady, boardLanding, stakes and the LOUD line stay held; Jo's marked confirm lifts; the pass flags the forged reversal", () => {
		const w = boardWorld();
		const surface = surfaceOf(w.ledger.path, w.c.now);
		try {
			let row = "";
			const close = w.ledger.closeWorkload.bind(w.ledger);
			w.ledger.closeWorkload = ((id: string, s: { by: string }) => {
				// The surface's first marked row sets the cutover after the landing's own rows; then a script's unmarked Jo instruction (F1).
				surface.recordInstruction({ ...JO, workloadId: id, body: "go on" });
				row = w.ledger.recordInstruction({ ...JO, workloadId: id, body: "ship it" });
				return close(id, s);
			}) as typeof w.ledger.closeWorkload;
			const wl = w.landing(119);
			w.ledger.closeWorkload = close;
			const CTX = { config: SERVED };
			const before = landingReady(w.ledger, wl, CTX);
			expect(before.ready).toBe(true);
			if (!before.ready) return;
			const pass = forgeryPass(w.ledger, AUTOBOARD_WINDOW_MS);
			expect(pass.hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[wl, row, "F1"]]);
			const hitEntry = pass.hits[0]!.entryId;
			expect(w.ledger.entry(hitEntry)!.workload_id).toBe(STANDING_WORKLOAD_ID);
			w.c.plusHours(0.01);

			// A script's surface-stamped reversal of the check's hit entry, on the standing workload where that entry sits.
			const forged = w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: forgeryReversedBody(hitEntry, "in-forged") });
			expect(unansweredHits(w.ledger, wl).map((h) => [h.rowId, h.entryId])).toEqual([[row, hitEntry]]);
			expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: `forgery hold: ${row} F1 unanswered` });
			expect(boardLanding(w.ledger, before)).toEqual({ boarded: false, reason: `forgery hold on ${wl}: ${row} unanswered` });
			expect(forgeryStakesHold(w.ledger, [wl])).toBe(`hold: forgery ${row} F1 on ${wl}`);
			expect(errorLines(w.ledger).filter((l) => l.kind === "forgery").map((l) => [l.workloadId, l.rowId])).toEqual([[wl, row]]);
			expect(interpret(surface, `reverse ${row}`, () => null)).toEqual({ kind: "forgery-reverse", workloadId: wl, on: STANDING_WORKLOAD_ID, rowId: row });

			confirm(surface, STANDING_WORKLOAD_ID, row);
			expect(unansweredHits(w.ledger, wl)).toEqual([]);
			expect(forgeryStakesHold(w.ledger, [wl])).toBeNull();
			// the forged reversal is flagged on the standing workload, where it sits; the closed workload's hold stays lifted
			expect(forgeryPass(w.ledger, AUTOBOARD_WINDOW_MS).hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[STANDING_WORKLOAD_ID, forged, "F1"]]);
			const after = landingReady(w.ledger, wl, CTX);
			expect(after.ready).toBe(true);
			if (!after.ready) return;
			expect(boardLanding(w.ledger, after)).toMatchObject({ boarded: true });
		} finally {
			surface.close();
		}
	});

	test("an unmarked reversal naming the check's forgery-hold stop request voids nothing: the runner still sees the stop, and the next pass writes no second hit or stop", () => {
		const { c, ledger } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "an autonomous workload", stakes: "normal", mode: "autonomous" });
		const lane = "lane-auto-1";
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: lane, leaseMs: 600_000 }).won).toBe(true);
		const row = forgedPlan(ledger, wl);
		c.plusHours(0.1);
		const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
		expect(pass.hits.map((h) => [h.rowId, h.rule])).toEqual([[row, "F5"]]);
		expect(pass.stops.map((s) => [s.workloadId, s.laneId])).toEqual([[wl, lane]]);
		c.plusHours(0.01);
		// A script writes surface-stamped reversals of the check's stop request and of its hit entry.
		for (const id of [pass.stops[0]!.entryId, pass.hits[0]!.entryId]) {
			ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: forgeryReversedBody(id, "in-forged") });
		}
		const es = ledger.entries(wl);
		expect(pendingStop(controlEntries(es, holdersOf(es, lane, ledger.holders(wl))), lane)).toMatchObject({ reason: "forgery-hold", by: FORGERY_CHECK_BY });
		expect(unansweredHits(ledger, wl).map((h) => h.rowId)).toEqual([row]);
		expect(forgeryPass(ledger, AUTOBOARD_WINDOW_MS)).toEqual({ hits: [], stops: [] });
	});

	test("an unmarked mode flip decides nothing about a lane's launch: the autonomous lane flipped to user-driven gets the check's stop; Jo's by-hand lane flipped to autonomous gets none", () => {
		const { c, ledger, path } = world();
		const auto = ledger.openWorkload({ by: SURFACE_BY, brief: "an autonomous workload", stakes: "normal", mode: "autonomous" });
		c.plusHours(0.01);
		const byHand = ledger.openWorkload({ by: SURFACE_BY, brief: "Jo's own workload", stakes: "normal", mode: "user-driven" });
		// Each lane launched as the starter launches it (`launch: <lane> cause first|interactive`), then claimed by its session.
		const autoRun = laneScript.reserve(ledger, auto, "test", false, SHOW);
		const handRun = laneScript.reserve(ledger, byHand, "jo", true, SHOW);
		if (!autoRun.ok || !handRun.ok) throw new Error(`reserve refused: ${JSON.stringify([autoRun, handRun])}`);
		for (const [wl, lane] of [[auto, autoRun.laneId], [byHand, handRun.laneId]] as const) {
			expect(ledger.claimWorkload(wl, { by: lane, holder: lane, leaseMs: 600_000 }).won).toBe(true);
		}
		const surface = surfaceOf(path, c.now);
		try {
			surface.recordInstruction({ ...JO, workloadId: auto, body: "go on" });
			expect(ledger.joChannelCutovers().surface).not.toBeNull();
			c.plusHours(0.01);
			// A script on the test's unmarked connection flips each workload's mode after the cutover (F1).
			const toHand = ledger.flipMode(auto, { ...JO, mode: "user-driven" });
			const toAuto = ledger.flipMode(byHand, { ...JO, mode: "autonomous" });
			expect([ledger.workload(auto)!.mode, ledger.workload(byHand)!.mode]).toEqual(["user-driven", "autonomous"]);
			c.plusHours(0.1);

			const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
			expect(pass.hits.map((h) => [h.workloadId, h.rowId, h.rule])).toEqual([[auto, toHand, "F1"], [byHand, toAuto, "F1"]]);
			expect(pass.stops.map((s) => [s.workloadId, s.laneId])).toEqual([[auto, autoRun.laneId]]);
			const control = (wl: string) => {
				const es = ledger.entries(wl);
				return controlEntries(es, holdersOf(es, ledger.workload(wl)!.holder, ledger.holders(wl)));
			};
			expect(pendingStop(control(auto), autoRun.laneId)).toMatchObject({ reason: "forgery-hold", by: FORGERY_CHECK_BY });
			expect(pendingStop(control(byHand), handRun.laneId)).toBeNull();
			expect(forgeryPass(ledger, AUTOBOARD_WINDOW_MS)).toEqual({ hits: [], stops: [] });
		} finally {
			surface.close();
		}
	});

	test("an unmarked reversal of a launch attempt hides no launch: consequences, the LOUD line and Jo's reverse receipt still name it", () => {
		const { c, ledger, path } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "an autonomous workload", stakes: "normal", mode: "autonomous" });
		const surface = surfaceOf(path, c.now);
		try {
			surface.recordInstruction({ ...JO, workloadId: wl, body: "go on" });
			c.plusHours(0.01);
			// A script's unmarked launch request after the cutover (F1), then the starter's real attempt citing it.
			const req = ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: launchRequestedBody("jo", ledger.now()) });
			const att = ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: lane-probe-1 cause request ${req} requested-by surface` });
			c.plusHours(0.1);
			const pass = forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
			expect(pass.hits.map((h) => [h.rowId, h.rule])).toEqual([[req, "F1"]]);
			const launched = `launched lane-probe-1 (${att})`;
			expect(consequences(ledger, { workloadId: wl, rowId: req })).toEqual([launched]);
			c.plusHours(0.01);

			// The script then writes a surface-stamped reversal of the launch attempt.
			ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: forgeryReversedBody(att, "in-forged") });
			expect(controlEntries(ledger.entries(wl)).some((e) => e.id === att)).toBe(false);
			expect(consequences(ledger, { workloadId: wl, rowId: req })).toEqual([launched]);
			const loud = errorLines(ledger).filter((l) => l.kind === "forgery");
			expect(loud.map((l) => [l.workloadId, l.rowId])).toEqual([[wl, req]]);
			expect(loud[0]!.line).toContain(`it led to ${launched};`);
			const cmd = interpret(surface, `reverse ${req}`, () => null);
			expect(cmd).toEqual({ kind: "forgery-reverse", workloadId: wl, on: wl, rowId: req });
			expect(apply(surface, cmd!, () => null)).toContain(`cannot be undone: ${launched}: that lane's commits, pushes and spend stay`);
		} finally {
			surface.close();
		}
	});
});

describe("R12: the launch reserve runs the check", () => {
	test("a hit no pass recorded yet refuses the autonomous launch, writes the hit row and raises one alarm; a clean workload launches", () => {
		const { c, ledger } = world();
		const forgedWl = ledger.openWorkload({ by: SURFACE_BY, brief: "forged between ticks", stakes: "normal", mode: "autonomous" });
		const clean = ledger.openWorkload({ by: SURFACE_BY, brief: "clean", stakes: "normal", mode: "autonomous" });
		const row = forgedPlan(ledger, forgedWl);
		c.plusHours(0.1);
		expect(unansweredHits(ledger, forgedWl)).toEqual([]);
		const notes: string[] = [];
		const spoken: string[] = [];
		const alarm = { notify: (_t: string, text: string) => { notes.push(text); return true; }, speak: (l: string) => { spoken.push(l); return true; } };

		expect(laneScript.reserve(ledger, forgedWl, "test", false, SHOW, alarm)).toEqual({ ok: false, reason: "forgery-hold" });
		const hits = ledger.entries(forgedWl).filter((e) => e.body.startsWith("forgery:"));
		expect(hits.map((e) => [e.created_by, e.body])).toEqual([[FORGERY_CHECK_BY, `forgery: hit ${row} F5`]]);
		expect(spoken).toEqual([`as2 forgery alert. 1 row on ${forgedWl}`]);
		expect(notes).toHaveLength(1);
		// no lane was reserved: no holder, no launch: attempt
		expect(ledger.workload(forgedWl)!.holder).toBeNull();
		expect(ledger.entries(forgedWl).some((e) => e.body.startsWith("launch:"))).toBe(false);

		// again: refused by the recorded hit, no second row, no second alarm
		expect(laneScript.reserve(ledger, forgedWl, "test", false, SHOW, alarm)).toEqual({ ok: false, reason: "forgery-hold" });
		expect(ledger.entries(forgedWl).filter((e) => e.body.startsWith("forgery:"))).toHaveLength(1);
		expect(spoken).toHaveLength(1);

		const ok = laneScript.reserve(ledger, clean, "test", false, SHOW, alarm);
		expect(ok.ok).toBe(true);
		expect(spoken).toHaveLength(1);
	});
});

describe("R13: the LOUD needs-you line", () => {
	test("each unanswered hit has a LOUD line with its row, rule, consequences and the two words; it goes once Jo confirms or reverses", () => {
		const { c, ledger, path } = world();
		const a = ledger.openWorkload({ by: SURFACE_BY, brief: "a", stakes: "normal", mode: "autonomous" });
		c.plusHours(0.01);
		const b = ledger.openWorkload({ by: SURFACE_BY, brief: "b", stakes: "normal", mode: "autonomous" });
		const rowA = forgedPlan(ledger, a);
		const rowB = forgedPlan(ledger, b);
		c.plusHours(0.1);
		expect(errorLines(ledger).filter((l) => l.kind === "forgery")).toEqual([]);
		forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
		const loud = () => errorLines(ledger).filter((l) => l.kind === "forgery");
		expect(loud().map((l) => [l.workloadId, l.rowId])).toEqual([[a, rowA], [b, rowB]]);
		const lineA = loud()[0]!.line;
		expect(lineA.startsWith(`LOUD: forgery check flagged ${rowA} on ${a} (F5, `)).toBe(true);
		expect(lineA).toContain("nothing cites it yet");
		expect(lineA).toContain(`answer confirm ${rowA} (it was Jo's) / reverse ${rowA} (it was not)`);
		// the forgery lines come first
		expect(errorLines(ledger)[0]!.kind).toBe("forgery");

		const surface = surfaceOf(path, c.now);
		confirm(surface, a, rowA);
		expect(loud().map((l) => l.rowId)).toEqual([rowB]);
		reverse(surface, b, rowB);
		expect(loud()).toEqual([]);
	});
});

describe("R14: merge-train.ts stakes --hold-ok", () => {
	const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
echo "gh: not found" >&2
exit 1
`;
	function script(dbPath: string) {
		const root = tmp("forgery-stakes");
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "prs"));
		writeFileSync(join(root, "bin", "gh"), GH);
		chmodSync(join(root, "bin", "gh"), 0o755);
		const pr = (n: number, branch: string) => writeFileSync(join(root, "prs", `${n}.json`), JSON.stringify({
			number: n, headRefName: branch, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" },
		}));
		const run = (n: number, o: { holdOk?: boolean; own?: string } = {}) => {
			const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, [LEDGER_DB_ENV]: dbPath };
			delete env.AGENT_SYSTEM_WORKLOAD_ID;
			if (o.own !== undefined) env.AGENT_SYSTEM_WORKLOAD_ID = o.own;
			const args = ["stakes", ...(o.holdOk === false ? [] : ["--hold-ok"]), "--repo", "thewolff/product", "--pr", String(n)];
			const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env });
			return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
		};
		return { pr, run };
	}

	test("a hit not yet recorded, then recorded, answers hold: forgery <row id>; confirmed, it does not; without --hold-ok no check runs", () => {
		const { c, ledger, path } = world();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "a PR's workload", stakes: "normal", mode: "autonomous" });
		const row = forgedPlan(ledger, wl);
		c.plusHours(0.1);
		const s = script(path);
		s.pr(7, `wl/${wl}`);
		expect(forgeryStakesHold(ledger, [wl])).toBe(`hold: forgery ${row} F5 on ${wl}`);
		expect(s.run(7)).toEqual({ code: 0, out: `hold: forgery ${row} F5 on ${wl}`, err: "" });
		expect(s.run(7, { holdOk: false }).out).not.toContain("forgery");
		forgeryPass(ledger, AUTOBOARD_WINDOW_MS);
		expect(unansweredHits(ledger, wl)).toHaveLength(1);
		expect(s.run(7).out).toBe(`hold: forgery ${row} F5 on ${wl}`);
		confirm(surfaceOf(path, c.now), wl, row);
		expect(forgeryStakesHold(ledger, [wl])).toBeNull();
		const after = s.run(7);
		expect(after.out).not.toContain("hold: forgery");
		expect(after.out.length).toBeGreaterThan(0);
	}, 30_000);

	test("the train's own workload (AGENT_SYSTEM_WORKLOAD_ID) is checked too; a clean PR workload alone holds nothing", () => {
		const { c, ledger, path } = world();
		const prWl = ledger.openWorkload({ by: SURFACE_BY, brief: "a clean PR workload", stakes: "normal", mode: "autonomous" });
		const train = ledger.openWorkload({ by: SURFACE_BY, brief: "merge train", stakes: "normal", mode: "autonomous" });
		const row = forgedPlan(ledger, train, "lane-train-1");
		c.plusHours(0.1);
		const s = script(path);
		s.pr(8, `wl/${prWl}`);
		expect(s.run(8, { own: train }).out).toBe(`hold: forgery ${row} F5 on ${train}`);
		expect(s.run(8).out).not.toContain("hold: forgery");
	}, 30_000);

	test("a closed workload's hit Jo reversed keeps landingReady, boardLanding and stakes --hold-ok refused, with no LOUD line; confirm lifts all three", () => {
		const w = boardWorld();
		// Each landing's lane forges a jo-only row just before the close.
		const forged = new Map<string, string>();
		const close = w.ledger.closeWorkload.bind(w.ledger);
		w.ledger.closeWorkload = ((id: string, s: { by: string }) => {
			forged.set(id, forgedPlan(w.ledger, id));
			return close(id, s);
		}) as typeof w.ledger.closeWorkload;
		const reversedWl = w.landing(121);
		const confirmedWl = w.landing(122);
		w.ledger.closeWorkload = close;
		const reversedRow = forged.get(reversedWl)!;
		const confirmedRow = forged.get(confirmedWl)!;
		const CTX = { config: SERVED };
		const reversedLanding = landingReady(w.ledger, reversedWl, CTX);
		expect(reversedLanding.ready).toBe(true);
		if (!reversedLanding.ready) return;
		forgeryPass(w.ledger, AUTOBOARD_WINDOW_MS);
		const s = script(w.ledger.path);
		s.pr(121, `wl/${reversedWl}`);
		s.pr(122, `wl/${confirmedWl}`);

		// Jo's answers to a closed workload's rows sit on the standing workload
		const surface = surfaceOf(w.ledger.path, w.c.now);
		reverse(surface, STANDING_WORKLOAD_ID, reversedRow);
		confirm(surface, STANDING_WORKLOAD_ID, confirmedRow);
		// answered both ways: the LOUD line goes
		expect(errorLines(w.ledger).filter((l) => l.kind === "forgery")).toEqual([]);

		// reversed: the train still refuses, in words of its own (the hit is answered, not unanswered)
		const refusedLanding = landingReady(w.ledger, reversedWl, CTX);
		expect(refusedLanding.ready).toBe(false);
		if (refusedLanding.ready) return;
		expect(refusedLanding.reason).toContain(reversedRow);
		expect(refusedLanding.reason).not.toContain("unanswered");
		const refusedBoard = boardLanding(w.ledger, reversedLanding);
		expect(refusedBoard.boarded).toBe(false);
		if (refusedBoard.boarded) return;
		expect(refusedBoard.reason).toContain(reversedRow);
		expect(refusedBoard.reason).not.toContain("unanswered");
		const held = s.run(121);
		expect(held.code).toBe(0);
		expect(held.out.startsWith(`hold: forgery ${reversedRow} F5 on ${reversedWl}`)).toBe(true);
		expect(held.out).not.toBe(`hold: forgery ${reversedRow} F5 on ${reversedWl}`);

		// confirmed: all three lift
		const after = landingReady(w.ledger, confirmedWl, CTX);
		expect(after.ready).toBe(true);
		if (!after.ready) return;
		expect(s.run(122).out).not.toContain("hold: forgery");
		expect(boardLanding(w.ledger, after)).toMatchObject({ boarded: true });
	}, 30_000);
});
