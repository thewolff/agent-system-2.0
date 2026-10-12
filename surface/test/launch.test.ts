// The launch predicate and its helpers over plain rows (DESIGN-lane-launcher.md § 8 "Predicate unit
// tests"): every § 3 / § 6 state as a row of the matrix, then the Codex-review regressions that
// live in surface/src/launch.ts (B6 null-start resume, S1 superseded done-because:, S7 merge line).
import { describe, expect, test } from "bun:test";
import { handBuilderBody, handCancelledBody, handSettledBody, handSpawnBody, laneBuilderBody, laneBuilderGapBody, reviewParkBody, reviewSameLabBody, reviewWithheldBody } from "../../classifier/src/lab";
import { reviewGroupBody, reviewLimitBody, reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, TEST_RUNNER_BY, type EntryRow, type InstructionRow, type ReserveRows, type WorkloadRow } from "../../ledger/src/index";
import {
	CLASSIFIER_MACHINERY_PREFIXES, controlEntries, decideInteractive, decideLaunch, doneBecause, exitClass, fencedBy, firstPrompt, holdersOf, INTENDED_OUTCOMES, joInstructionsFor, LANE_OUTCOMES, laneArgv, launchable, maxTimeMs,
	reservedPrefix,
	type Resolution, resumePlan, resumeSession, verdictOf,
} from "../src/launch";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";

const NOW = "2026-10-01T10:00:00.000Z";
const workload = (over: Partial<WorkloadRow> = {}): WorkloadRow => ({
	id: "wl-m", brief: "do the thing", stakes: "normal", mode: "autonomous", status: "open", holder: null, holder_lease_until: null,
	open_slices: 0, paused_slices: 0, open_questions: 0, held_messages: 0, closed_at: null, created_by: "o", created_at: NOW,
	changed_by: "o", changed_at: NOW, rev: 0, ...over,
} as WorkloadRow);
let seq = 0;
const entry = (by: string, body: string): EntryRow => ({
	id: `e-${++seq}`, workload_id: "wl-m", slice_id: null, kind: "assumption", body, created_by: by, created_at: `2026-10-01T09:${String(seq).padStart(2, "0")}:00.000Z`,
} as EntryRow);
const control = (rows: EntryRow[], holder: string | null = null) => controlEntries(rows, holdersOf(rows, holder));
const launch = (lane: string, cause: string) => entry(LANE_STARTER_BY, `launch: ${lane} cause ${cause} requested-by jo`);
const started = (lane: string, session: string | null, by = LANE_RUNNER_BY) => entry(by, `lane-started: ${lane} ${JSON.stringify({ pid: 1, start: "x", session, argv: [], runnerPid: 2 })}`);
const resolution = (instructionId: string, laneId: string): Resolution => ({ instructionId, questionId: "q1", laneId, kind: "answer", body: "yes", createdAt: NOW });

describe("launch predicate matrix (§ 3 states)", () => {
	const rows: [string, WorkloadRow, EntryRow[], Resolution[], number, unknown][] = [
		["first launch", workload(), [], [], 0, { launch: true, cause: { kind: "first" } }],
		["closed", workload({ status: "closed" }), [], [], 0, { launch: false, reason: "closed" }],
		["standing", workload({ id: STANDING_WORKLOAD_ID }), [], [], 0, { launch: false, reason: "standing" }],
		["due row", workload({ brief: "due: remind me" }), [], [], 0, { launch: false, reason: "due" }],
		["user-driven", workload({ mode: "user-driven" }), [], [], 0, { launch: false, reason: "user-driven" }],
		["held under a live lease", workload({ holder: "lane-m-1", holder_lease_until: "2026-10-01T10:05:00.000Z" }), [], [], 0, { launch: false, reason: "held" }],
		["held with no lease (Jo after a handoff)", workload({ holder: "jo" }), [], [], 0, { launch: false, reason: "held" }],
		["lapsed lease is not held", workload({ holder: "lane-m-1", holder_lease_until: "2026-10-01T09:00:00.000Z" }), [], [], 0, { launch: true, cause: { kind: "first" } }],
		["cap reached", workload(), [], [], 3, { launch: false, reason: "cap" }],
		["died, not relaunched", workload(), [launch("lane-m-1", "first")], [], 0, { launch: false, reason: "died-not-relaunched" }],
		["resume after an answer", workload(), [launch("lane-m-1", "first")], [resolution("in-1", "lane-m-1")], 0, { launch: true, cause: { kind: "resume", ids: ["in-1"] } }],
		["resume already consumed (tick catch-up idempotence)", workload(), [launch("lane-m-1", "first"), launch("lane-m-2", "resume in-1")], [resolution("in-1", "lane-m-1")], 0, { launch: false, reason: "died-not-relaunched" }],
		["a launch: stamped by a lane is not an attempt", workload(), [entry("lane-m-9", "launch: lane-m-9 cause first requested-by me")], [], 0, { launch: true, cause: { kind: "first" } }],
	];
	for (const [name, w, entries, resolved, live, want] of rows) {
		test(name, () => {
			const c = control(entries, w.holder);
			const v = launchable(w, c, null, resolved, NOW, live, 3);
			if (typeof want === "object" && want !== null && "cause" in want && (want as { cause: { kind: string; id?: string } }).cause.kind === "request") {
				expect(v).toMatchObject({ launch: true, cause: { kind: "request" } });
				expect((v as { cause: { id: string } }).cause.id).toMatch(/^e-\d+$/);
			} else expect(v).toEqual(want);
		});
	}
	test("the request-consumed row consumes by the request entry's real id", () => {
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		const c = control([launch("lane-m-1", "first"), req, launch("lane-m-2", `request ${req.id}`)]);
		expect(launchable(workload(), c, null, [], NOW, 0, 3)).toEqual({ launch: false, reason: "died-not-relaunched" });
	});
});

describe("awaiting close: the holder's done-because: stands (L1, the by-hand wasted launch)", () => {
	const rows = (w: WorkloadRow, entries: EntryRow[], holders: string[] = []): ReserveRows => ({
		workload: w, entries, questions: [], instructions: [], slices: [], holders, liveLanes: 0, cap: 3, now: NOW,
	});
	const done = (by: string) => entry(by, "done-because: all five slices done");
	test("a by-hand holder's receipt, no launch: history: the ledger's recorded holder makes it the holder's; nothing launches", () => {
		expect(verdictOf(rows(workload(), [done("lane-plumb-by-hand")], ["lane-plumb-by-hand"]))).toEqual({ launch: false, reason: "awaiting-close" });
		expect(decideLaunch(rows(workload(), [done("lane-plumb-by-hand")], ["lane-plumb-by-hand"]))).toEqual({ launch: false, reason: "awaiting-close" });
	});
	test("a launched lane's receipt after its launch: attempt: awaiting close, not died-not-relaunched", () => {
		expect(verdictOf(rows(workload(), [launch("lane-m-1", "first"), done("lane-m-1")]))).toEqual({ launch: false, reason: "awaiting-close" });
	});
	test("a receipt by someone who never held the workload is not a receipt: launchable as before", () => {
		expect(verdictOf(rows(workload(), [done("hand-x")], ["lane-plumb-by-hand"]))).toEqual({ launch: true, cause: { kind: "first" } });
	});
	test("a later ordinary note by the holder supersedes the receipt (doneBecause): the cause logic decides as before", () => {
		const note = () => entry("lane-plumb-by-hand", "acceptance is no longer met");
		expect(verdictOf(rows(workload(), [done("lane-plumb-by-hand"), note()], ["lane-plumb-by-hand"]))).toEqual({ launch: true, cause: { kind: "first" } });
		expect(verdictOf(rows(workload(), [launch("lane-m-1", "first"), done("lane-m-1"), entry("lane-m-1", "the line went to the wrong README")]))).toEqual({ launch: false, reason: "died-not-relaunched" });
	});
	test("held under a live lease with a receipt: held, not awaiting close", () => {
		const w = workload({ holder: "lane-m-1", holder_lease_until: "2026-10-01T10:05:00.000Z" });
		expect(verdictOf(rows(w, [launch("lane-m-1", "first"), done("lane-m-1")]))).toEqual({ launch: false, reason: "held" });
	});
	test("Jo's unconsumed launch-requested: wins over the receipt: the request launches, so the tick never closes it", () => {
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		expect(verdictOf(rows(workload(), [launch("lane-m-1", "first"), done("lane-m-1"), req]))).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		// once a lane consumed it, the next receipt stands again
		expect(verdictOf(rows(workload(), [launch("lane-m-1", "first"), req, launch("lane-m-2", `request ${req.id}`), done("lane-m-2")]))).toEqual({ launch: false, reason: "awaiting-close" });
	});
	test("user-driven and closed keep their reasons: awaiting-close is only for an autonomous workload the tick would launch", () => {
		expect(verdictOf(rows(workload({ mode: "user-driven" }), [done("lane-m-1")], ["lane-m-1"]))).toEqual({ launch: false, reason: "user-driven" });
		expect(verdictOf(rows(workload({ status: "closed" }), [done("lane-m-1")], ["lane-m-1"]))).toEqual({ launch: false, reason: "closed" });
	});
	test("item 40 (wl-mv049108m8whds): the runner's lane-decided: after the holder's receipt neither supersedes it nor counts as one: still awaiting close", () => {
		const marker = entry(LANE_RUNNER_BY, "lane-decided: lane-m-1 completed");
		expect(doneBecause([done("lane-m-1"), marker], ["lane-m-1"])).toBe("all five slices done");
		expect(verdictOf(rows(workload(), [launch("lane-m-1", "first"), done("lane-m-1"), marker]))).toEqual({ launch: false, reason: "awaiting-close" });
	});
});

describe("item 109: a launch verdict carries the starter's settle of every hand the launched lane orphans", () => {
	const rows = (w: WorkloadRow, entries: EntryRow[]): ReserveRows => ({ workload: w, entries, questions: [], instructions: [], slices: [], holders: [], liveLanes: 0, cap: 3, now: NOW });
	const spawn = (lane: string, token: string, review: boolean) => ({
		...entry(lane, `hand-spawn: ${token} session /s/${lane} spawn sl-fix review ${review ? "yes" : "no"} group dg-${token} row anthropic/claude-opus-5-5,openai-codex/gpt-6-sol`),
		slice_id: "sl-x",
	});
	test("Jo's relaunch after a lease lapse (the 2026-10-11T18:10:46Z shape): the lapsed lane's open hands settle orphaned in the launch verdict, a review's round with them", () => {
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW} relaunch after lease lapse`);
		const entries = [launch("lane-m-1", "first"), started("lane-m-1", "/s"), spawn("lane-m-1", "dt-mv19brokdc5afe0d", false), spawn("lane-m-1", "dt-mv1911h67667a865", true), req];
		expect(decideLaunch(rows(workload(), entries))).toEqual({
			launch: true,
			cause: `request ${req.id}`,
			also: [
				{ sliceId: "sl-x", body: "hand-settled: dt-mv19brokdc5afe0d orphaned lane lane-m-1 reason superseded-without-lane-exit" },
				{ sliceId: "sl-x", body: "hand-settled: dt-mv1911h67667a865 orphaned lane lane-m-1 reason superseded-without-lane-exit" },
				{ sliceId: "sl-x", body: "review-round: sl-x round 1 token dt-mv1911h67667a865 group dg-dt-mv1911h67667a865 verdict orphaned blocking unknown counts unknown" },
			],
		});
		// A settled hand, and a lane with nothing open, add nothing; a refusal carries no settles.
		expect(decideLaunch(rows(workload(), [...entries, { ...entry("lane-m-1", "hand-settled: dt-mv19brokdc5afe0d routing rt-1"), slice_id: "sl-x" }]))).toMatchObject({ also: [expect.objectContaining({ body: expect.stringContaining("dt-mv1911h67667a865 orphaned") }), expect.anything()] });
		expect(decideLaunch(rows(workload(), [launch("lane-m-1", "first")]))).toEqual({ launch: false, reason: "died-not-relaunched" });
	});
	test("the interactive launch (as2 lane <wl>) settles the same way", () => {
		const entries = [launch("lane-m-1", "first"), started("lane-m-1", "/s"), spawn("lane-m-1", "dt-1", false), entry(LANE_RUNNER_BY, "lane-exit: lane-m-1 code 1 signal - outcome died")];
		expect(decideInteractive(rows(workload({ mode: "user-driven" }), entries))).toEqual({
			launch: true,
			cause: "interactive",
			also: [{ sliceId: "sl-x", body: "hand-settled: dt-1 orphaned lane lane-m-1 reason superseded-after-lane-exit" }],
		});
	});
});

describe("exit classification (decision 14)", () => {
	test("parked and accepted stop are intended; a request alone, a start, or nothing is not", () => {
		const lane = "lane-m-1";
		expect(exitClass(control([started(lane, "/s")]), lane)).toBe("unintended");
		expect(exitClass(control([started(lane, "/s"), entry(LANE_RUNNER_BY, `lane-parked: ${lane} questions q1 session /s`)]), lane)).toBe("intended");
		expect(exitClass(control([entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`)]), lane)).toBe("unintended");
		expect(exitClass(control([entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`), entry(LANE_RUNNER_BY, `lane-stop: ${lane} accepted e-1`)]), lane)).toBe("intended");
		expect(exitClass([], lane)).toBe("unintended");
	});
	test("R5 (Codex review 2): a later lane-started:/lane-ready: (session metadata) does not turn an accepted stop or a park back into unintended", () => {
		const lane = "lane-m-1";
		const req = entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`);
		expect(exitClass(control([started(lane, null), req, entry(LANE_RUNNER_BY, `lane-stop: ${lane} accepted ${req.id}`), started(lane, "/s")]), lane)).toBe("intended");
		expect(exitClass(control([started(lane, null), entry(LANE_RUNNER_BY, `lane-parked: ${lane} questions q1 session /s`), started(lane, "/s"), entry(LANE_RUNNER_BY, `lane-ready: ${lane} at ${NOW}`)]), lane)).toBe("intended");
		// metadata alone is still no intent
		expect(exitClass(control([started(lane, null), started(lane, "/s")]), lane)).toBe("unintended");
	});
	test("a spend: after an accepted stop or a park (the ceiling meter's record) does not turn the end unintended; spend: alone is no intent", () => {
		const lane = "lane-m-1";
		const spend = () => entry(LANE_RUNNER_BY, `spend: ${lane} usd 12.5 tokens 1000 wall 3`);
		expect(exitClass(control([started(lane, null), entry(LANE_RUNNER_BY, `lane-stop: ${lane} accepted ceiling`), spend()]), lane)).toBe("intended");
		expect(exitClass(control([started(lane, null), entry(LANE_RUNNER_BY, `lane-parked: ${lane} questions q1 session /s`), spend()]), lane)).toBe("intended");
		expect(exitClass(control([started(lane, null), spend()]), lane)).toBe("unintended");
	});
	test("every runner outcome is classified; the intended ones are the design's four plus released and interactive", () => {
		expect(Object.keys(INTENDED_OUTCOMES).sort()).toEqual([...LANE_OUTCOMES].sort());
		expect(LANE_OUTCOMES.filter((o) => INTENDED_OUTCOMES[o])).toEqual(["completed", "parked", "resume-pending", "stop", "released", "interactive"]);
		// MIGRATION.md item 40: a turn ended (or a release made) with work open is a death
		expect(LANE_OUTCOMES).toContain("open-work");
		expect(INTENDED_OUTCOMES["open-work"]).toBe(false);
	});
	test("item 40 (wl-mv049108m8whds): the runner's lane-decided: <lane> completed is intended, and a stop request after it does not undo that", () => {
		const lane = "lane-m-1";
		const decided = () => entry(LANE_RUNNER_BY, `lane-decided: ${lane} completed`);
		expect(exitClass(control([started(lane, "/s"), decided()]), lane)).toBe("intended");
		expect(exitClass(control([started(lane, "/s"), decided(), entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`)]), lane)).toBe("intended");
	});
	test("item 40: a park followed by a stop request with no acceptance yet is intended: the request is skipped, the acceptance is the intent", () => {
		const lane = "lane-m-1";
		expect(exitClass(control([started(lane, "/s"), entry(LANE_RUNNER_BY, `lane-parked: ${lane} questions q1 session /s`), entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`)]), lane)).toBe("intended");
	});
	test("item 40: a stop request alone, or after lane-started:, is still unintended", () => {
		const lane = "lane-m-1";
		const req = () => entry(SURFACE_BY, `lane-stop: ${lane} requested mode-flip by jo`);
		expect(exitClass(control([req()]), lane)).toBe("unintended");
		expect(exitClass(control([started(lane, "/s"), req()]), lane)).toBe("unintended");
	});
	test("item 40: a lane-decided: naming a death, an object-prototype key, nothing, or another lane is no intent", () => {
		const lane = "lane-m-1";
		for (const rest of ["open-work", "toString", "__proto__", "constructor", ""]) {
			const body = rest === "" ? `lane-decided: ${lane}` : `lane-decided: ${lane} ${rest}`;
			expect([rest, exitClass(control([started(lane, "/s"), entry(LANE_RUNNER_BY, body)]), lane)]).toEqual([rest, "unintended"]);
		}
		expect(exitClass(control([started(lane, "/s"), entry(LANE_RUNNER_BY, "lane-decided: lane-m-2 completed")]), lane)).toBe("unintended");
	});
});

describe("control writers (Codex review 2, R4)", () => {
	test("launch-failed: is accepted from the starter and from the runner (its readiness failure), never from a lane", () => {
		const lane = "lane-m-1";
		const body = `launch-failed: ${lane} readiness: never ready in 3m`;
		expect(control([entry(LANE_STARTER_BY, body)]).map((c) => c.prefix)).toEqual(["launch-failed"]);
		expect(control([entry(LANE_RUNNER_BY, body)]).map((c) => [c.prefix, c.laneId, c.createdBy])).toEqual([["launch-failed", lane, LANE_RUNNER_BY]]);
		expect(control([entry(lane, body)], lane)).toEqual([]);
	});
	test("ceiling: is the surface's alone and spend: the runner's alone; the lane tools' refusal sees both as reserved", () => {
		const ceiling = "ceiling: usd 50 wall 360 source stakes normal";
		const spend = "spend: lane-m-1 usd 1 tokens 10 wall 2";
		expect(control([entry(SURFACE_BY, ceiling), entry(LANE_RUNNER_BY, spend)]).map((c) => [c.prefix, c.laneId])).toEqual([["ceiling", null], ["spend", "lane-m-1"]]);
		expect(control([entry(LANE_RUNNER_BY, ceiling), entry("lane-m-1", ceiling), entry(SURFACE_BY, spend), entry("lane-m-1", spend)], "lane-m-1")).toEqual([]);
		expect([reservedPrefix(ceiling), reservedPrefix(spend)]).toEqual(["ceiling", "spend"]);
	});
	test("released-open: (MIGRATION.md item 40) is honoured only from a holder writing about itself; the lane tools' refusal sees it as reserved", () => {
		const lane = "lane-m-1";
		const body = `released-open: ${lane} slices 2`;
		const rows = [launch(lane, "first"), launch("lane-m-2", "request e-1")];
		expect(control([...rows, entry(lane, body)]).map((c) => [c.prefix, c.laneId, c.rest])).toEqual([["launch", lane, "cause first requested-by jo"], ["launch", "lane-m-2", "cause request e-1 requested-by jo"], ["released-open", lane, "slices 2"]]);
		// another holder about this lane, the runner, the surface, or a lane that never held: dropped
		expect(control([...rows, entry("lane-m-2", body), entry(LANE_RUNNER_BY, body), entry(SURFACE_BY, body), entry("lane-m-9", `released-open: lane-m-9 slices 1`)]).filter((c) => c.prefix === "released-open")).toEqual([]);
		expect(reservedPrefix(body)).toBe("released-open");
	});
	test("item 40 (wl-mv049108m8whds): lane-decided: from the lane itself or the surface is dropped", () => {
		const body = "lane-decided: lane-m-1 completed";
		expect(control([entry("lane-m-1", body), entry(SURFACE_BY, body)], "lane-m-1").filter((c) => c.body.startsWith("lane-decided:"))).toEqual([]);
	});
	test("item 40: lane-decided: is reserved (the lane tools refuse it) and honoured from the runner", () => {
		const body = "lane-decided: lane-m-1 completed";
		expect(reservedPrefix(body)).toBe("lane-decided");
		expect(control([entry(LANE_RUNNER_BY, body)]).map((c) => [c.prefix, c.laneId, c.rest, c.createdBy])).toEqual([["lane-decided", "lane-m-1", "completed", LANE_RUNNER_BY]]);
	});
	test("test-requested: and test-run: are the test runner's alone; push-dest: is a holder's, like done-because:", () => {
		const sha = "a".repeat(40);
		const requested = `test-requested: tr-1 pr=17 sha=${sha} slice=sl-full-m-1 by=lane-m-1`;
		const result = `test-run: tr-1 green sha=${sha} pr=17 {}`;
		const dest = `push-dest: origin wl/wl-other ${sha}`;
		const holder = "lane-m-1";
		expect(TEST_RUNNER_BY).toBe("test-runner");
		expect(control([entry(TEST_RUNNER_BY, requested), entry(TEST_RUNNER_BY, result)]).map((c) => [c.prefix, c.createdBy])).toEqual([["test-requested", TEST_RUNNER_BY], ["test-run", TEST_RUNNER_BY]]);
		for (const forger of [holder, LANE_RUNNER_BY, LANE_STARTER_BY, SURFACE_BY]) expect(control([entry(forger, requested), entry(forger, result)], holder)).toEqual([]);
		expect(control([entry(holder, dest)], holder).map((c) => [c.prefix, c.rest])).toEqual([["push-dest", `origin wl/wl-other ${sha}`]]);
		expect(control([entry("lane-x-9", dest), entry(TEST_RUNNER_BY, dest), entry(SURFACE_BY, dest)], holder)).toEqual([]);
	});
	test("the lane tools' refusal sees test-requested:, test-run: and push-dest: as reserved; test-run-failed: is a pushed signal, not a control line", () => {
		expect(["test-requested: tr-1 pr=1", "test-run: tr-1 green", "push-dest: origin wl/x"].map(reservedPrefix)).toEqual(["test-requested", "test-run", "push-dest"]);
		expect(reservedPrefix("test-run-failed: wl-m sl-x red")).toBeNull();
	});
});

describe("resume session (Codex review B6)", () => {
	test("a later start record with a null session does not hide the earlier session; a parked session counts; none recorded is null", () => {
		const lane = "lane-m-1";
		expect(resumeSession(control([started(lane, "/one.jsonl"), started("lane-m-2", null)]))).toBe("/one.jsonl");
		expect(resumeSession(control([started(lane, null)]))).toBeNull();
		expect(resumeSession(control([started(lane, "/one.jsonl"), entry(LANE_RUNNER_BY, `lane-parked: ${lane} questions q1 session /two.jsonl`)]))).toBe("/two.jsonl");
		expect(resumeSession(control([started(lane, "/one.jsonl", LANE_STARTER_BY)]))).toBe("/one.jsonl");
		expect(resumeSession(control([started(lane, "/one.jsonl", "lane-m-1")]))).toBeNull();
	});
	test("resumePlan picks the raising lane's session for a resume cause, else the newest on the workload", () => {
		const c = control([launch("lane-m-1", "first"), started("lane-m-1", "/one.jsonl"), launch("lane-m-2", "request e-9"), started("lane-m-2", "/two.jsonl"), launch("lane-m-3", "resume in-1")]);
		expect(resumePlan(c, "lane-m-3", [resolution("in-1", "lane-m-1")], null).resume).toBe("/one.jsonl");
		expect(resumePlan(c, "lane-m-2", [], null).resume).toBe("/two.jsonl");
		expect(resumePlan(c, "lane-m-3", [resolution("in-1", "lane-m-7")], null).resume).toBe("/two.jsonl");
	});
});

describe("done-because: receipt (decision 16, Codex review S1)", () => {
	test("the holder's newest lane/surface assumption must be the receipt; a later plain note supersedes it; machinery lines and artifact records are skipped", () => {
		const holders = ["lane-m-1"];
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass")], holders)).toBe("tests pass");
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry("lane-m-1", "acceptance is no longer met")], holders)).toBeNull();
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry(SURFACE_BY, "Jo says not yet")], holders)).toBeNull();
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry(LANE_RUNNER_BY, "lane-exit: lane-m-1 code 0 signal - outcome completed"), entry(SURFACE_BY, "repo: /r")], holders)).toBe("tests pass");
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry("lane-m-1", "artifact-command: bun test")], holders)).toBe("tests pass");
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry("lane-m-1", 'artifact-tree: {"repo":"/r","tree":"t","command":"bun test"}')], holders)).toBe("tests pass");
		expect(doneBecause([entry("lane-m-1", "done-because: tests pass"), entry("lane-m-1", "reserved-withdrawn: en-1 went another way")], holders)).toBe("tests pass");
		expect(doneBecause([entry("hand-x", "done-because: I say so")], holders)).toBeNull();
		expect(doneBecause([entry(SURFACE_BY, "done-because: the surface says so")], holders)).toBeNull();
	});

	test("the classifier's machinery lines stamped with the lane id (a hand settling after the receipt) leave it standing; an ordinary note after them still supersedes it (review round 1, N3)", () => {
		const holders = ["lane-m-1"];
		const receipt = entry("lane-m-1", "done-because: tests pass");
		const settled = entry("lane-m-1", handSettledBody("dt-a", "rt-1"));
		const round = entry("lane-m-1", reviewRoundBody({ slice: "sl-x", round: 1, token: "dt-a", group: "dg-a", verdict: "accepted", findings: UNKNOWN }));
		expect(doneBecause([receipt, settled, round], holders)).toBe("tests pass");
		expect(doneBecause([receipt, settled, round, entry("lane-m-1", "acceptance is no longer met")], holders)).toBeNull();
		// closed list: a prefixed lane note that is not the classifier's still supersedes
		expect(doneBecause([receipt, entry("lane-m-1", "next: rerun the suite")], holders)).toBeNull();
		expect(doneBecause([receipt, entry("lane-m-1", "review-rounds: 5 source x by in-1")], holders)).toBeNull();
	});

	test("CLASSIFIER_MACHINERY_PREFIXES names the prefix of every body the classifier records as the lane", () => {
		const bodies = [
			handSpawnBody({ token: "dt-a", root: "/r", spawnKey: "sl-x", review: true, group: "dg-a", row: ["m"] }), handSettledBody("dt-a", "rt-1"),
			reviewWithheldBody("dt-a"), handCancelledBody("dt-a"), reviewParkBody("q-1", "sl-x"), reviewSameLabBody("in-1", "dt-a"), laneBuilderBody("anthropic", "lane-m-1", "m"),
			handBuilderBody(null, "dt-a", "m"), reviewRoundBody({ slice: "sl-x", round: 1, token: "dt-a", group: "dg-a", verdict: "accepted", findings: UNKNOWN }),
			reviewGroupBody("sl-x", "dg-a", ["dt-a"]), reviewLimitBody("q-1", "sl-x"), reviewLoopEndBody("sl-x", "pass"), laneBuilderGapBody("lane lane-m-1 has no model"),
			// classifier/extension.ts providerRefusedBody is module-private: its shape, as written there
			"provider-refused: openai-codex status 401 token dt-a",
		];
		for (const b of bodies) expect(CLASSIFIER_MACHINERY_PREFIXES as readonly string[]).toContain(/^([a-z-]+):/.exec(b)![1]!);
		expect(new Set(bodies.map((b) => /^([a-z-]+):/.exec(b)![1])).size).toBe(CLASSIFIER_MACHINERY_PREFIXES.length);
	});
});

describe("max-time and the fence check", () => {
	test("maxTimeMs parses OMP's forms; the fence covers subpaths and literals", () => {
		expect(maxTimeMs("2h")).toBe(7_200_000);
		expect(maxTimeMs("90")).toBe(90_000);
		expect(maxTimeMs("1.5m")).toBe(90_000);
		expect(maxTimeMs("2d")).toBeNull();
		expect(fencedBy("/home/j/.agent-system-2/lanes/x", [{ kind: "subpath", path: "/home/j/.agent-system-2" }])).toBe("/home/j/.agent-system-2");
		expect(fencedBy("/home/j/.agent-system-2-lanes/x", [{ kind: "subpath", path: "/home/j/.agent-system-2" }])).toBeNull();
		expect(fencedBy("/home/j/ledger.db", [{ kind: "literal", path: "/home/j/ledger.db" }])).toBe("/home/j/ledger.db");
		expect(fencedBy("/home/j/ledger.db/x", [{ kind: "literal", path: "/home/j/ledger.db" }])).toBeNull();
	});
	test("laneArgv renders --max-time as the ceiling's remaining wall plus 10 minutes when given, else the configured value", () => {
		const spec = { worktree: "/w", sessionDir: "/s", systemPromptPath: "/p", maxTime: "2h", resume: null };
		const maxTimeOf = (argv: string[]) => argv[argv.indexOf("--max-time") + 1];
		expect(maxTimeOf(laneArgv(spec))).toBe("2h");
		expect(maxTimeOf(laneArgv({ ...spec, remainingWallMin: null }))).toBe("2h");
		expect(maxTimeOf(laneArgv({ ...spec, remainingWallMin: 14.2 }))).toBe("25m");
		expect(maxTimeOf(laneArgv({ ...spec, remainingWallMin: -3 }))).toBe("10m");
		expect(maxTimeMs(maxTimeOf(laneArgv({ ...spec, remainingWallMin: 350 }))!)).toBe(360 * 60_000);
	});
});

describe("first prompt merge line (decision 11, Codex review S7)", () => {
	const prompt = (machinery: boolean, stakes: WorkloadRow["stakes"]) => firstPrompt({
		workload: workload({ stakes }), laneId: "lane-m-1", repo: "/r", worktree: "/r-lanes/wl-m", branch: "wl/wl-m", done: "it works", planFirst: null,
		decisionLog: "", facts: "", resolved: [], instructions: [], machinery, tools: ["lane_release"],
	});
	test("the machinery repo never merges; a product repo follows the stakes table", () => {
		expect(prompt(true, "production")).toContain("never merge on this repo: Jo integrates it.");
		expect(prompt(false, "production")).toContain("the merge is Jo's");
		expect(prompt(false, "normal")).toContain("merge proceeds on a judge slice's pass");
		expect(prompt(false, "throwaway")).toContain("merge when green");
	});
});

describe("first prompt carries the repo facts block (MIGRATION.md item 106, PLAN wl-mv4r19j1q885xc § 2.3)", () => {
	const prompt = (facts: string, decisionLog: string) => firstPrompt({
		workload: workload(), laneId: "lane-m-1", repo: "/r", worktree: "/r-lanes/wl-m", branch: "wl/wl-m", done: "it works", planFirst: null,
		decisionLog, facts, resolved: [], instructions: [], machinery: true, tools: ["lane_release", "lane_read_facts"],
	});
	const block = "## Repo facts (/r): showing 1 of 1 under 8,000 bytes; `lane_read_facts` for the rest or another repo\n- the build uses bun (m8-x-#1; a.md:1-2)";

	test("the facts block follows the tools line and precedes the decision-log context", () => {
		const text = prompt(`${block}\n`, "# Decision log for this repository (1 entry from the last 14 days)");
		const tools = text.indexOf("Call `ledger_wake_read` first");
		const facts = text.indexOf("## Repo facts (/r)");
		const log = text.indexOf("## Decision-log context");
		expect(tools).toBeGreaterThan(-1);
		expect(facts).toBeGreaterThan(tools);
		expect(log).toBeGreaterThan(facts);
		expect(text).toContain(`${block}\n\n## Decision-log context`);
	});

	test("a blank facts block adds no section", () => {
		const text = prompt(" \n", "");
		expect(text).not.toContain("## Repo facts");
		expect(text.endsWith("`lane_handoff` when Jo is taking the workload over.")).toBe(true);
		expect(prompt("", "")).toBe(text);
	});
});

describe("first prompt carries Jo's instructions since the previous lane started (M7 follow-ups item 14)", () => {
	/** `t` plus `s` seconds, inside the minute the `entry` helper stamped. */
	const at = (t: string, s: number) => `${t.slice(0, -7)}${String(s).padStart(2, "0")}.000Z`;
	const instruction = (id: string, createdAt: string, body: string, over: Partial<InstructionRow> = {}): InstructionRow => ({
		id, workload_id: "wl-m", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface", author: "jo",
		body, created_by: "orchestrator", created_at: createdAt, ...over,
	});
	const prompt = (laneId: string, instructions: readonly InstructionRow[], resolved: (Resolution & { question: string })[] = []) => firstPrompt({
		workload: workload(), laneId, repo: "/r", worktree: "/r-lanes/wl-m", branch: "wl/wl-m", done: "it works", planFirst: null,
		decisionLog: "", facts: "", resolved, instructions, machinery: true, tools: ["lane_release"],
	});
	const wakeLine = (text: string) => text.indexOf("Call `ledger_wake_read` first");

	test("wl-muolz8qtp6ylfk: a resumed lane reads both instructions Jo wrote while no lane was live, oldest first, before its wake read", () => {
		const l3 = launch("lane-m-3", "first");
		const t0 = l3.created_at;
		const old = instruction("i-old", "2026-10-01T08:00:00.000Z", "an instruction the previous lane already had");
		const answer = instruction("i-ans", at(t0, 5), "yes, go ahead", { kind: "answer", question_id: "q1" });
		const plumb = instruction("i-plumb", at(t0, 10), "proof script goes to Plumb, not Jo");
		const orch = instruction("i-orch", at(t0, 15), "orchestrator note", { author: "orchestrator" });
		const note = instruction("i-note", at(t0, 20), "ledger note for Plumb, no message to Jo");
		const rows = [l3, started("lane-m-3", "/three.jsonl"), launch("lane-m-4", "resume i-ans")];
		const owed = joInstructionsFor(control(rows), [old, answer, plumb, orch, note], "lane-m-4");
		const text = prompt("lane-m-4", owed, [{ ...resolution("i-ans", "lane-m-3"), createdAt: answer.created_at, question: "go ahead?" }]);

		const header = text.indexOf("Jo's instructions on this workload since the previous lane started (oldest first):");
		const first = text.indexOf(`- i-plumb (${plumb.created_at}, surface): proof script goes to Plumb, not Jo`);
		const second = text.indexOf(`- i-note (${note.created_at}, surface): ledger note for Plumb, no message to Jo`);
		expect(header).toBeGreaterThan(-1);
		expect(first).toBeGreaterThan(header);
		expect(second).toBeGreaterThan(first);
		expect(wakeLine(text)).toBeGreaterThan(second);
		expect(text).toContain("the newest one that applies wins");
		expect(text).not.toContain("i-old");
		expect(text).not.toContain("i-orch");
	});

	test("the first lane on a workload (no previous launch) gets every Jo row", () => {
		const l1 = launch("lane-m-1", "first");
		const early = instruction("i-early", "2026-10-01T08:00:00.000Z", "use the staging db");
		const late = instruction("i-late", at(l1.created_at, 30), "no, use prod");
		const text = prompt("lane-m-1", joInstructionsFor(control([l1]), [early, late], "lane-m-1"));
		expect(text.indexOf("- i-early")).toBeGreaterThan(-1);
		expect(text.indexOf("- i-late")).toBeGreaterThan(text.indexOf("- i-early"));
		expect(wakeLine(text)).toBeGreaterThan(text.indexOf("- i-late"));
	});

	test("an answer already shown in the resume block is not listed again; with nothing else owed there is no instructions section", () => {
		const answer = instruction("i-ans", NOW, "yes, go ahead", { kind: "answer", question_id: "q1" });
		const text = prompt("lane-m-4", [answer], [{ ...resolution("i-ans", "lane-m-3"), question: "go ahead?" }]);
		expect(text.split("i-ans").length - 1).toBe(1);
		expect(text).not.toContain("Jo's instructions on this workload");
	});
});
