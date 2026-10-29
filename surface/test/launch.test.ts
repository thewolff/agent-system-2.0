// The launch predicate and its helpers over plain rows (DESIGN-lane-launcher.md § 8 "Predicate unit
// tests"): every § 3 / § 6 state as a row of the matrix, then the Codex-review regressions that
// live in surface/src/launch.ts (B6 null-start resume, S1 superseded done-because:, S7 merge line).
import { describe, expect, test } from "bun:test";
import { handBuilderBody, handSettledBody, handSpawnBody, laneBuilderBody, reviewParkBody, reviewSameLabBody, reviewWithheldBody } from "../../classifier/src/lab";
import { reviewGroupBody, reviewLimitBody, reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import {
	LANE_RUNNER_BY, LANE_STARTER_BY, TEST_RUNNER_BY, type EntryRow, type InstructionRow, type QuestionRow, type ReserveRows, type WorkloadRow,
} from "../../ledger/src/index";
import {
	boundPrs, CLASSIFIER_MACHINERY_PREFIXES, controlEntries, decideInteractive, decideLaunch, doneBecause, exitClass, fencedBy, firstPrompt, holdersOf, INTENDED_OUTCOMES, joInstructionsFor, LANE_OUTCOMES, laneArgv, laneEnv,
	laneExitBody, laneReadyBody, launchable, laneStopAcceptedBody, laneStopRequestBody, launchFailedBody, launchRequestedBody, maxTimeMs,
	PLAN_FILE_MAX_BYTES, PLAN_QUESTION_SHAPE, PLAN_REQUIREMENTS_SHAPE, planAutoApprovedBody, planFirst, planFirstBody, planHaltedBody, planQuestionProblem, prBindingInstructionBody,
	PRIORITY_REASON_PREFIX, priorityPausedOf, priorityPausingOf, requirementsProblem, reservedPrefix, supersededBody, supersededBy, supersedeInstructionBody,
	testPrBody, testPrInstructionBody, type Resolution, resumePlan, resumeSession, TRAIN_LANDS_LINE, verdictOf, waivedPrs, waivePrBody, waivePrInstructionBody,
	withdrawInstructionBody, withdrawnBody, withdrawnBy, landFirstBody, landFirstInstructionBody, landFirstOn, mainRetries, mainRetryBody, mainRetryInstructionBody, sameRepo,
} from "../src/launch";
import { consumedByReady, TRAIN_LAUNCH_LIMIT, TRAIN_LAUNCH_OPTIONS, trainLaunchFailures, type TrainLaunchRows } from "../src/merge-train";
import type { CleanShellRead } from "../../gates/src/clean-shell";
import { SHELL_START_HOOK_NAMES } from "../../gates/src/shell-start";
import { pairOfferBody, pairSignalBody, pairSignalFailedBody } from "../src/pair-suggest";
import { ESCALATION_BY, MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";

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
		workload: w, entries, questions: [], instructions: [], slices: [], holders, liveLanes: 0, capExempt: false, cap: 3, now: NOW,
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
	test("test-pr: (PLAN wl-mv5qdfvv82ivwg § 2.2) is the surface's alone; the lane tools' refusal sees it as reserved", () => {
		const body = "test-pr: 79 70 in-1";
		const holder = "lane-m-1";
		expect(control([entry(SURFACE_BY, body)]).map((c) => [c.prefix, c.laneId, c.rest, c.createdBy])).toEqual([["test-pr", null, "79 70 in-1", SURFACE_BY]]);
		for (const forger of [holder, "lane-x-9", LANE_RUNNER_BY, LANE_STARTER_BY, TEST_RUNNER_BY]) expect(control([entry(forger, body)], holder)).toEqual([]);
		expect(reservedPrefix(body)).toBe("test-pr");
	});
	test("waive-pr: (PLAN wl-mvfjen3q5mqi2o D3) is the surface's alone; the lane tools' refusal sees it as reserved", () => {
		const body = "waive-pr: 79 70 in-1";
		const holder = "lane-m-1";
		expect(control([entry(SURFACE_BY, body)]).map((c) => [c.prefix, c.laneId, c.rest, c.createdBy])).toEqual([["waive-pr", null, "79 70 in-1", SURFACE_BY]]);
		for (const forger of [holder, "lane-x-9", LANE_RUNNER_BY, LANE_STARTER_BY, TEST_RUNNER_BY]) expect(control([entry(forger, body)], holder)).toEqual([]);
		expect(reservedPrefix(body)).toBe("waive-pr");
	});
});

describe("waivedPrs: Jo's waive-pr binding (PLAN wl-mvfjen3q5mqi2o D3, D5)", () => {
	let n = 0;
	const instruction = (over: Partial<InstructionRow> = {}): InstructionRow => ({
		id: `in-w${++n}`, workload_id: "wl-m", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface",
		author: "jo", body: "", created_by: SURFACE_BY, created_at: NOW, ...over,
	});
	/** Jo's instruction for `prs` on wl-m plus the surface's entry naming it, as `apply` writes them. */
	const waive = (prs: number[], over: Partial<InstructionRow> = {}) => {
		const ins = instruction({ body: waivePrInstructionBody("wl-m", prs), ...over });
		return { ins, ent: entry(SURFACE_BY, waivePrBody(prs, ins.id)) };
	};
	test("the bodies: Jo's instruction and the surface's entry naming it", () => {
		expect(waivePrInstructionBody("wl-m", [79, 70])).toBe("waive-pr wl-m 79 70");
		expect(waivePrBody([79, 70], "in-1")).toBe("waive-pr: 79 70 in-1");
	});
	test("a surface entry naming Jo's surface instruction with the same numbers waives them, with that instruction; never as a test-run binding", () => {
		const { ins, ent } = waive([79, 70]);
		expect(waivedPrs([ent], [ins])).toEqual([{ pr: 79, instructionId: ins.id }, { pr: 70, instructionId: ins.id }]);
		expect(boundPrs([ent], [ins])).toEqual([]);
		expect(boundPrs([ent], [ins], { entries: () => [ent], instructions: () => [ins] })).toEqual([]);
		// and a test-pr binding is no waiver
		const t = instruction({ body: testPrInstructionBody("wl-m", [73]) });
		const te = entry(SURFACE_BY, testPrBody([73], t.id));
		expect(waivedPrs([ent, te], [ins, t])).toEqual([{ pr: 79, instructionId: ins.id }, { pr: 70, instructionId: ins.id }]);
		expect(boundPrs([ent, te], [ins, t])).toEqual([{ pr: 73, by: t.id }]);
	});
	test("a lane-written or other machinery-written entry waives nothing, even naming Jo's real instruction", () => {
		const { ins } = waive([79]);
		for (const forger of ["lane-m-1", LANE_RUNNER_BY, LANE_STARTER_BY, TEST_RUNNER_BY]) expect(waivedPrs([entry(forger, waivePrBody([79], ins.id))], [ins])).toEqual([]);
	});
	test("a surface entry naming an instruction that is not Jo's surface instruction, or on another workload, waives nothing", () => {
		for (const over of [{ author: "lane-m-1" }, { created_by: "lane-m-1" }, { kind: "answer" as const }, { channel: "direct" as const, created_by: "lane-m-1" }, { workload_id: "wl-other" }]) {
			const { ins, ent } = waive([79], over);
			expect(waivedPrs([ent], [ins])).toEqual([]);
		}
		const { ent } = waive([79]);
		expect(waivedPrs([ent], [])).toEqual([]);
		const elsewhere = instruction({ workload_id: "wl-other", body: waivePrInstructionBody("wl-other", [79]) });
		expect(waivedPrs([entry(SURFACE_BY, waivePrBody([79], elsewhere.id))], [elsewhere])).toEqual([]);
	});
	test("numbers that differ from the instruction's, or another word's instruction, waive nothing", () => {
		const ins = instruction({ body: waivePrInstructionBody("wl-m", [79]) });
		expect(waivedPrs([entry(SURFACE_BY, waivePrBody([79, 70], ins.id))], [ins])).toEqual([]);
		expect(waivedPrs([entry(SURFACE_BY, waivePrBody([70], ins.id))], [ins])).toEqual([]);
		expect(waivedPrs([entry(SURFACE_BY, `waive-pr: 079 ${ins.id}`)], [instruction({ id: ins.id, body: "waive-pr wl-m 079" })])).toEqual([]);
		expect(waivedPrs([entry(SURFACE_BY, `waive-pr: ${ins.id}`)], [ins])).toEqual([]);
		const testPr = instruction({ body: testPrInstructionBody("wl-m", [79]) });
		expect(waivedPrs([entry(SURFACE_BY, waivePrBody([79], testPr.id))], [testPr])).toEqual([]);
	});
	test("the orchestrator's recorded instruction shape waives nothing", () => {
		const ins = instruction({ body: 'Jo: "waive-pr wl-m 79" — reading: waive PR 79 on wl-m for the close check' });
		expect(waivedPrs([entry(SURFACE_BY, waivePrBody([79], ins.id))], [ins])).toEqual([]);
	});
	test("two words accumulate in order; a number waived twice keeps its first instruction", () => {
		const one = waive([79, 70]);
		const two = waive([73, 79]);
		expect(waivedPrs([one.ent, two.ent], [one.ins, two.ins])).toEqual([
			{ pr: 79, instructionId: one.ins.id }, { pr: 70, instructionId: one.ins.id }, { pr: 73, instructionId: two.ins.id },
		]);
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
			reviewWithheldBody("dt-a"), reviewParkBody("q-1", "sl-x"), reviewSameLabBody("in-1", "dt-a"), laneBuilderBody("anthropic", "lane-m-1", "m"),
			handBuilderBody(null, "dt-a", "m"), reviewRoundBody({ slice: "sl-x", round: 1, token: "dt-a", group: "dg-a", verdict: "accepted", findings: UNKNOWN }),
			reviewGroupBody("sl-x", "dg-a", ["dt-a"]), reviewLimitBody("q-1", "sl-x"), reviewLoopEndBody("sl-x", "pass"),
			// classifier/extension.ts providerRefusedBody is module-private: its shape, as written there
			"provider-refused: openai-codex status 401 token dt-a",
			// classifier/extension.ts's headroom skip (PLAN wl-mv71x5rwdu7eo0 § 3), its shape as a literal so it loads on the baseline
			"headroom-skip: anthropic/claude-opus-5-5 token dt-a anthropic 5h 0.85 used > 0.80",
			pairSignalBody({ taste: { choice: "no", confidence: 0.9 }, ambiguous: { choice: "no", confidence: 0.8 } }, "typesafe/jev-1", 1145, 0.0000481),
			pairSignalFailedBody(1, "timeout", null, null), pairOfferBody("q-1", "round-limit", ["a"]),
			// surface/src/pair-suggest.ts pairExposureBody: the lane's own record that the switch covered it (review round 2)
			"pair-exposure: lane-m-1 on",
			// classifier/src/lab.ts reviewSameLabRuleBody (PLAN wl-mv5xay6bjp0268 § 2.2), as a literal so it loads on the baseline
			"review-same-lab-rule: in-mv5xafhywe3w8w slice sl-x token dt-a labs openai,anthropic kimi no kimi entry in the deep review row (KIMI_OUT_RULE.rowOmission)",
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

describe("laneEnv drops the shell-start hooks only where the clean-shell switch is on for the workload (review r1 finding 2), and sets no PI_NO_PTY", () => {
	const base: Record<string, string> = { HOME: "/h", PATH: "/bin", PI_NO_PTY: "0" };
	for (const name of SHELL_START_HOOK_NAMES) base[name] = "x";
	const binding = { workloadId: "wl-a", laneId: "lane-a-1" };

	test('on for this workload ("all", or listed): every hook name is dropped; the rest and the binding pass through', () => {
		for (const read of [{ ok: true, value: "all" }, { ok: true, value: ["wl-b", "wl-a"] }] as CleanShellRead[]) {
			const env = laneEnv(base, binding, read);
			expect({ read, kept: SHELL_START_HOOK_NAMES.filter((n) => Object.hasOwn(env, n)) }).toEqual({ read, kept: [] });
			expect({ HOME: env.HOME, PATH: env.PATH, PI_NO_PTY: env.PI_NO_PTY, wl: env.AGENT_SYSTEM_WORKLOAD_ID, lane: env.AGENT_SYSTEM_LANE_ID }).toEqual({ HOME: "/h", PATH: "/bin", PI_NO_PTY: "0", wl: "wl-a", lane: "lane-a-1" });
		}
	});

	test("off, another workload's list, or an unreadable or malformed switch: nothing is dropped (main's env)", () => {
		for (const read of [{ ok: true, value: "off" }, { ok: true, value: ["wl-b"] }, { ok: false, error: "gates.cleanShell is 7" }] as CleanShellRead[]) {
			const env = laneEnv(base, binding, read);
			expect({ read, kept: SHELL_START_HOOK_NAMES.filter((n) => Object.hasOwn(env, n)) }).toEqual({ read, kept: [...SHELL_START_HOOK_NAMES] });
		}
	});

	test("PI_NO_PTY passes through as the starter has it, or not at all", () => {
		expect(Object.hasOwn(laneEnv({ HOME: "/h" }, binding, { ok: true, value: "all" }), "PI_NO_PTY")).toBe(false);
	});

	test("repair authority never passes into a lane", () => {
		const env = laneEnv({ ...base, AGENT_SYSTEM_SELF_REPAIR: "1", AGENT_SYSTEM_SELF_REPAIR_ROOTS: "/repo:/profile" }, binding, { ok: true, value: "off" });
		expect(env.AGENT_SYSTEM_SELF_REPAIR).toBeUndefined();
		expect(env.AGENT_SYSTEM_SELF_REPAIR_ROOTS).toBeUndefined();
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

	test("R13: an autonomous normal lane on a runner-served repo is told the merge train lands its PR, never to have Jo integrate it", () => {
		const lane = (over: Partial<WorkloadRow>, runnerServed: boolean, trainOrFix: boolean, machinery = true) => firstPrompt({
			workload: workload({ stakes: "normal", mode: "autonomous", ...over }), laneId: "lane-m-1", repo: "/r", worktree: "/r-lanes/wl-m", branch: "wl/wl-m", done: "it works",
			planFirst: null, decisionLog: "", facts: "", resolved: [], instructions: [], machinery, tools: ["lane_release"], runnerServed, trainOrFix,
		});
		const line = (text: string) => text.split("\n").find((l) => l.startsWith("worktree: "))!;
		for (const machinery of [true, false]) {
			const served = line(lane({}, true, false, machinery));
			expect(served).toEndWith(TRAIN_LANDS_LINE);
			expect(served).not.toContain("Jo integrates");
			expect(served).not.toContain("tell Jo");
			for (const s of ["cross-lab review", "green at its head", "record done-because and release", "the merge train lands the PR"]) expect(served).toContain(s);
		}
		// everyone else keeps the current text: a repo the runner does not serve, a train or fix lane, other stakes, a user-driven lane
		expect(line(lane({}, false, false))).toContain("never merge on this repo: Jo integrates it.");
		expect(line(lane({}, false, false, false))).toContain("merge proceeds on a judge slice's pass");
		expect(line(lane({}, true, true))).toContain("never merge on this repo: Jo integrates it.");
		expect(line(lane({}, true, true, false))).toContain("merge proceeds on a judge slice's pass");
		expect(line(lane({ stakes: "production" }, true, false, false))).toContain("the merge is Jo's");
		expect(line(lane({ stakes: "throwaway" }, true, false, false))).toContain("merge when green");
		expect(line(lane({ mode: "user-driven" }, true, false))).toContain("never merge on this repo: Jo integrates it.");
		for (const text of [lane({}, false, false), lane({}, true, true), lane({ stakes: "production" }, true, false), lane({ mode: "user-driven" }, true, false)]) {
			expect(line(text)).not.toContain(TRAIN_LANDS_LINE);
		}
	});
});

describe("first prompt carries the plan requirements grammar on plan-first lanes only (PLAN wl-mv8vwb04cy18n4 D4, R6)", () => {
	const prompt = (planFirst: string | null) => firstPrompt({
		workload: workload(), laneId: "lane-m-1", repo: "/r", worktree: "/r-lanes/wl-m", branch: "wl/wl-m", done: "it works", planFirst,
		decisionLog: "", facts: "", resolved: [], instructions: [], machinery: true, tools: ["lane_release"],
	});
	test("the plan first: block renders PLAN_QUESTION_SHAPE with its prompt-only line and PLAN_REQUIREMENTS_SHAPE; a lane with no plan gets neither", () => {
		const planned = prompt("production");
		expect(planned).toContain(PLAN_QUESTION_SHAPE);
		expect(planned).toContain("prompt-only: <R id>: ");
		expect(planned).toContain(PLAN_REQUIREMENTS_SHAPE);
		expect(planned.indexOf(PLAN_REQUIREMENTS_SHAPE)).toBeLessThan(planned.indexOf("Change slices are refused until Jo approves."));
		const plain = prompt(null);
		expect(plain).not.toContain(PLAN_REQUIREMENTS_SHAPE);
		expect(plain).not.toContain("## Requirements");
	});
});

/** The `R<n>` ids a refusal names, unique and sorted: what a lane acts on, whatever the sentence around them says. */
const idsIn = (problem: string | null) => [...new Set(problem?.match(/\bR\d+\b/g) ?? [])].sort();

describe("requirementsProblem: the plan file's `## Requirements` section (PLAN wl-mv8vwb04cy18n4 D1, R2)", () => {
	/** A plan file around `section` (the lines under the heading), with prose and a table in the sections before and after. */
	const file = (section: string[], eol = "\n") => ["# PLAN", "", "## Design", "", "Prose; with a semicolon => and an arrow.", "", "## Requirements", ...section, "## Slices", "", "| a | b |", "prose after"].join(eol);
	const VALID = [
		"",
		"- R1: a => b, arrows in the requirement text => test surface/test/a.test.ts; code surface/src/a.ts fn",
		"",
		"- R2: two tests of one kind => test surface/test/a.test.ts; test surface/test/b.test.ts",
		"- R3: the SPEC prose states the rule => prompt-only: human-read prose no code can judge",
		"- R4: a gate and a hook => gate row 6; hook pre-commit",
		"",
	];
	const one = (line: string) => requirementsProblem(file([line])).problem;

	test("a valid section passes, blank lines included, and returns its prompt-only ids; a CRLF file passes the same", () => {
		expect(requirementsProblem(file(VALID))).toEqual({ problem: null, promptOnly: ["R3"] });
		expect(requirementsProblem(file(VALID, "\r\n"))).toEqual({ problem: null, promptOnly: ["R3"] });
		// the section ends at a `# ` heading too; what follows it is not read
		expect(requirementsProblem(["## Requirements", "- R1: x => test y", "# Appendix", "anything"].join("\n"))).toEqual({ problem: null, promptOnly: [] });
	});

	test("no section, a duplicate section, and a section with no requirement line are refused, naming no requirement", () => {
		for (const text of ["# PLAN\n\n- R1: x => test y\n", "## Requirements \n- R1: x => test y\n", file(["", ""])]) {
			const problem = requirementsProblem(text).problem;
			expect(problem).not.toBeNull();
			expect(problem).toContain("`## Requirements`");
			expect(idsIn(problem)).toEqual([]);
		}
		// a second heading names both heading lines
		const twice = requirementsProblem(file([...VALID, "## Requirements", "- R9: x => test y"])).problem;
		expect(twice).toMatch(/\b7\b/);
		expect(twice).toMatch(/\b15\b/);
		expect(idsIn(twice)).toEqual([]);
	});

	test("each defect is refused, naming its requirement; an unparseable line is refused by its line number", () => {
		for (const line of [
			"- R1: no enforcer", "- R1: x => ", "- R1:  => test y", "- R1: x => tests y", "- R1: x => Test y", "- R1: x => code",
			"- R1: x => test a; ; test b", "- R1: x => test a;b", "- R1: x => test y; test y", "- R1: x => prompt-only: because",
			"- R1: x => test y; prompt-only: no code reaches it",
		]) {
			expect([line, idsIn(one(line))]).toEqual([line, ["R1"]]);
		}
		for (const line of ["### A sub-heading", "  - R1: a sub-bullet => test y", "- r1: lower-case id => test y", "```"]) {
			expect([line, one(line)]).toEqual([line, expect.stringMatching(/\bline 8\b/)]);
		}
		// D1: prompt-only is the whole enforcer part, so `; ` inside its reason is reason text, not a separator
		expect(requirementsProblem(file(["- R1: x => prompt-only: a one-time proof; no committed code re-runs it"]))).toEqual({ problem: null, promptOnly: ["R1"] });
		// trailing whitespace at the end of the line is not a separator
		expect(requirementsProblem(file(["- R1: x => test y; code z  ", "- R2: y => prompt-only: two words\t"]))).toEqual({ problem: null, promptOnly: ["R2"] });
	});

	test("an enforcer is its kind, exactly one space and a locator: double spaces, a tab, leading whitespace and no space are refused, naming the requirement", () => {
		for (const line of [
			"- R1: x => test  surface/test/a.test.ts", "- R1: x => test\tsurface/test/a.test.ts", "- R1: x => test a; code  b",
			"- R1: x =>  test a", "- R1: x => test a;  code b", "- R1: x => test a; \tcode b",
		]) {
			const problem = one(line);
			expect([line, idsIn(problem)]).toEqual([line, ["R1"]]);
			expect(problem).toContain("`<kind> <locator>`");
		}
		// no space at all reads as one unknown kind word: still refused, naming the requirement
		expect(idsIn(one("- R1: x => testsurface/test/a.test.ts"))).toEqual(["R1"]);
		// the clean requirement beside a bad separator is not named
		const { problem } = requirementsProblem(file(["- R1: fine => test a", "- R2: x => gate  row 6"]));
		expect(idsIn(problem)).toEqual(["R2"]);
	});

	test("a prompt-only part is exactly `prompt-only: ` then its reason: no space, a double colon, spaces before the colon, two spaces after it, and a bare prompt-only are refused", () => {
		for (const part of ["prompt-only:why not", "prompt-only:: why not", "prompt-only  : why not", "prompt-only :why not", "prompt-only:  why not", "prompt-only:\twhy not", "prompt-only", "prompt-only:"]) {
			const problem = one(`- R1: x => ${part}`);
			expect([part, idsIn(problem)]).toEqual([part, ["R1"]]);
			expect(problem).toContain("`prompt-only: <reason>`");
		}
		// a well-formed prompt-only line beside them is neither named nor returned while the section is refused
		const r = requirementsProblem(file(["- R1: x => prompt-only: two words", "- R2: y => prompt-only:: two words"]));
		expect(idsIn(r.problem)).toEqual(["R2"]);
		expect(r.promptOnly).toEqual([]);
	});

	test("every offender in one section is named, and a well-formed line beside them is not", () => {
		const { problem, promptOnly } = requirementsProblem(file([
			"- R1: fine => test a",
			"- R2: no enforcer",
			"- R3: x => hooks y",
			"Some prose.",
			"- R2: the id again => gate row 6",
			"- R4: x => prompt-only: short",
			"- R5: x => code  two spaces",
		]));
		expect(idsIn(problem)).toEqual(["R2", "R3", "R4", "R5"]);
		expect(problem).toMatch(/\bline 11\b/);
		expect(promptOnly).toEqual([]);
	});

	test("a requirement id used twice is refused, naming that id alone, even when both lines are well formed", () => {
		const r = requirementsProblem(file(["- R1: x => test a", "- R2: y => test b", "- R2: z => gate row 6"]));
		expect(r.problem).not.toBeNull();
		expect(idsIn(r.problem)).toEqual(["R2"]);
		expect(r.promptOnly).toEqual([]);
	});
});

describe("planQuestionProblem reads the plan file (PLAN wl-mv8vwb04cy18n4 D2, D3, R3)", () => {
	const PATH = "/plans/PLAN.md";
	const REVIEW = "review: approve-as-is, openai-codex/gpt-6-sol, /plans/PLAN-REVIEW-r1.md";
	const WITH = ["# PLAN", "## Requirements", "- R1: x => test a", "- R2: y => prompt-only: prose no code can judge", "- R3: z => prompt-only: a one-time live observation"].join("\n");
	const WITHOUT = ["# PLAN", "## Requirements", "- R1: x => test a"].join("\n");
	/** `head` padded with `pad` to exactly `bytes` UTF-8 bytes (`pad` one byte or more, dividing the gap). */
	const sized = (head: string, bytes: number, pad = "x") => `${head}${pad.repeat((bytes - Buffer.byteLength(head)) / Buffer.byteLength(pad))}`;
	const SIZED_HEAD = `${WITHOUT}\n## Slices\n`;
	const files: Record<string, string> = {
		[PATH]: WITH, "/plans/PLAN-none.md": WITHOUT, "/plans/PLAN-bad.md": "# PLAN\n## Requirements\n- R1: no enforcer\n",
		"/plans/PLAN-max.md": sized(SIZED_HEAD, PLAN_FILE_MAX_BYTES),
		"/plans/PLAN-over.md": sized(SIZED_HEAD, PLAN_FILE_MAX_BYTES + 1),
		"/plans/PLAN-over-bad.md": sized("# PLAN\n## Requirements\n- R1: no enforcer\n## Slices\n", PLAN_FILE_MAX_BYTES + 1),
	};
	const check = (path: string, promptOnly: string[], tradeoffs = ["tradeoff: one"]) =>
		planQuestionProblem([path, "- sl-1: the one slice", ...promptOnly, ...tradeoffs, REVIEW].join("\n"), () => true, (p) => files[p] ?? null);
	const r2 = "prompt-only: R2: the SPEC prose states the rule";
	const r3 = "prompt-only: R3: a live observation after the merge";

	test("a body whose prompt-only ids equal the file's passes; `prompt-only: none` passes on a file with none", () => {
		expect(check(PATH, [r2, r3])).toBeNull();
		expect(check(PATH, [r3, r2])).toBeNull();
		expect(check("/plans/PLAN-none.md", ["prompt-only: none"])).toBeNull();
	});

	test("missing, extra and duplicate ids are each named and no matched id is; none with items, none missing and none mixed with ids are refused", () => {
		expect(idsIn(check(PATH, [r2]))).toEqual(["R3"]);
		expect(idsIn(check(PATH, []))).toEqual(["R2", "R3"]);
		expect(idsIn(check(PATH, [r2, r3, "prompt-only: R1: x"]))).toEqual(["R1"]);
		expect(idsIn(check(PATH, [r2, r3, r3]))).toEqual(["R3"]);
		expect(idsIn(check(PATH, [r2, "prompt-only: R1: x", "prompt-only: R1: again"]))).toEqual(["R1", "R3"]);
		expect(idsIn(check(PATH, ["prompt-only: none"]))).toEqual(["R2", "R3"]);
		expect(idsIn(check("/plans/PLAN-none.md", ["prompt-only: R1: x", "prompt-only: none"]))).toEqual(["R1"]);
		// refusals that name no id: each still refuses, and points at `prompt-only: none`
		for (const [path, promptOnly] of [["/plans/PLAN-none.md", []], ["/plans/PLAN-none.md", ["prompt-only: none", "prompt-only: none"]], [PATH, [r2, r3, "prompt-only: none"]]] as const) {
			const problem = check(path, [...promptOnly]);
			expect(problem).toContain("`prompt-only: none`");
			expect(idsIn(problem)).toEqual([]);
		}
	});

	test("order: the structural problem wins first, then an unreadable or oversized plan file, then its requirements, then the id match", () => {
		// structural first: neither the bad file's R1 nor the body's unmatched R2 is named
		const structural = check("/plans/PLAN-bad.md", [r2], []);
		expect(structural).toContain("`tradeoff:`");
		expect(idsIn(structural)).toEqual([]);
		const order = planQuestionProblem([PATH, r2, "- sl-1: the slice", "tradeoff: one", REVIEW].join("\n"), () => true, () => WITH);
		expect(order).toMatch(/\bline 3\b/);
		expect(idsIn(order)).toEqual([]);
		// the requirements before the id match: the file's R1 is named, the body's extra R2 is not
		expect(idsIn(check("/plans/PLAN-bad.md", [r2]))).toEqual(["R1"]);
		expect(check("/plans/missing.md", ["prompt-only: none"])).toContain("/plans/missing.md");
		// the size before the requirements: an oversized file whose section is bad is refused for its size, naming no id
		const over = check("/plans/PLAN-over-bad.md", [r2]);
		expect(over).toContain(`${PLAN_FILE_MAX_BYTES} bytes`);
		expect(idsIn(over)).toEqual([]);
	});

	test("a plan file of PLAN_FILE_MAX_BYTES bytes is judged; one byte more is refused for its size, counted in UTF-8 bytes, not characters", () => {
		expect(Buffer.byteLength(files["/plans/PLAN-max.md"]!)).toBe(PLAN_FILE_MAX_BYTES);
		expect(check("/plans/PLAN-max.md", ["prompt-only: none"])).toBeNull();
		expect(check("/plans/PLAN-over.md", ["prompt-only: none"])).toContain(`${PLAN_FILE_MAX_BYTES} bytes`);
		// two-byte characters: fewer than PLAN_FILE_MAX_BYTES characters, more bytes
		const wide = sized(SIZED_HEAD, PLAN_FILE_MAX_BYTES + 2 + (Buffer.byteLength(SIZED_HEAD) % 2), "é");
		expect(wide.length).toBeLessThan(PLAN_FILE_MAX_BYTES);
		expect(planQuestionProblem(["/plans/PLAN-wide.md", "- sl-1: the one slice", "prompt-only: none", "tradeoff: one", REVIEW].join("\n"), () => true, () => wide)).toContain(`${PLAN_FILE_MAX_BYTES} bytes`);
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

describe("supersededBy: Jo's `supersede` word on A (PLAN wl-mv5i3lulwwbbi8 D2)", () => {
	const jo = (id: string, body: string, over: Partial<InstructionRow> = {}): InstructionRow => ({
		id, workload_id: "wl-m", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface", author: "jo",
		body, created_by: SURFACE_BY, created_at: NOW, ...over,
	});
	const word = jo("in-1", supersedeInstructionBody("wl-m", "wl-b"));

	test("the surface's entry naming Jo's instruction on A is the successor; the newest valid one wins", () => {
		expect(supersededBody("wl-b", "in-1")).toBe("superseded: wl-b in-1");
		expect(supersededBy([entry(SURFACE_BY, supersededBody("wl-b", "in-1"))], [word])).toEqual({ by: "wl-b", instructionId: "in-1" });
		const later = jo("in-2", supersedeInstructionBody("wl-m", "wl-c"));
		const both = [entry(SURFACE_BY, supersededBody("wl-b", "in-1")), entry(SURFACE_BY, supersededBody("wl-c", "in-2"))];
		expect(supersededBy(both, [word, later])).toEqual({ by: "wl-c", instructionId: "in-2" });
		// The newest names a forged instruction: the older valid one stands.
		expect(supersededBy([...both, entry(SURFACE_BY, supersededBody("wl-d", "in-9"))], [word, later])).toEqual({ by: "wl-c", instructionId: "in-2" });
		expect(supersededBy([], [word])).toBeNull();
	});

	test("counts for nothing: a lane's entry, or an instruction not Jo's surface word for this A and B", () => {
		const body = supersededBody("wl-b", "in-1");
		expect(supersededBy([entry("lane-m-1", body)], [word])).toBeNull();
		expect(controlEntries([entry("lane-m-1", body)], ["lane-m-1"])).toEqual([]);
		expect(supersededBy([entry(SURFACE_BY, body)], [])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { author: "lane-m-1" })])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { created_by: "lane-m-1", channel: "direct" })])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { kind: "answer" })])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { workload_id: "wl-other" })])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, body)], [jo("in-1", supersedeInstructionBody("wl-m", "wl-c"))])).toBeNull();
		expect(supersededBy([entry(SURFACE_BY, "superseded: wl-b")], [word])).toBeNull();
	});
});

describe("withdrawn: Jo's `withdraw <wl>` word (PLAN wl-mv8s939084z1ts D3, D6)", () => {
	const jo = (id: string, body: string, over: Partial<InstructionRow> = {}): InstructionRow => ({
		id, workload_id: "wl-m", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface", author: "jo",
		body, created_by: SURFACE_BY, created_at: NOW, ...over,
	});
	const word = jo("in-1", withdrawInstructionBody("wl-m"));
	const rows = (w: WorkloadRow, entries: EntryRow[], instructions: InstructionRow[] = [word], holders: string[] = []): ReserveRows => ({
		workload: w, entries, questions: [], instructions, slices: [], holders, liveLanes: 0, capExempt: false, cap: 3, now: NOW,
	});

	test("the surface's entry naming Jo's instruction on the workload stands; the newest valid one wins", () => {
		expect(withdrawInstructionBody("wl-m")).toBe("withdraw wl-m");
		expect(withdrawnBody("in-1")).toBe("withdrawn: in-1");
		expect(reservedPrefix(withdrawnBody("in-1"))).toBe("withdrawn");
		expect(withdrawnBy([entry(SURFACE_BY, withdrawnBody("in-1"))], [word])).toEqual({ instructionId: "in-1" });
		const later = jo("in-2", withdrawInstructionBody("wl-m"));
		const both = [entry(SURFACE_BY, withdrawnBody("in-1")), entry(SURFACE_BY, withdrawnBody("in-2"))];
		expect(withdrawnBy(both, [word, later])).toEqual({ instructionId: "in-2" });
		// The newest names a forged instruction: the older valid one stands.
		expect(withdrawnBy([...both, entry(SURFACE_BY, withdrawnBody("in-9"))], [word, later])).toEqual({ instructionId: "in-2" });
		expect(withdrawnBy([], [word])).toBeNull();
	});

	test("forgeries count for nothing: a lane's entry, or an instruction not Jo's surface word for this workload", () => {
		const body = withdrawnBody("in-1");
		expect(withdrawnBy([entry("lane-m-1", body)], [word])).toBeNull();
		expect(controlEntries([entry("lane-m-1", body)], ["lane-m-1"])).toEqual([]);
		expect(withdrawnBy([entry(SURFACE_BY, body)], [])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { author: "lane-m-1" })])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { author: "orchestrator" })])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { created_by: "lane-m-1", channel: "direct" })])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { kind: "answer" })])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", word.body, { workload_id: "wl-other" })])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, body)], [jo("in-1", withdrawInstructionBody("wl-other"))])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, "withdrawn:")], [word])).toBeNull();
		expect(withdrawnBy([entry(SURFACE_BY, "withdrawn: in-1 and more")], [word])).toBeNull();
	});

	test("launchable: withdrawn beats an unconsumed launch-requested:, a receipt, the user-driven return and a live holder; closed, standing and due still come first", () => {
		const withdrawn = entry(SURFACE_BY, withdrawnBody("in-1"));
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		const done = entry("lane-m-1", "done-because: all five slices done");
		const tried = launch("lane-m-1", "first");
		const no = { launch: false, reason: "withdrawn" } as const;
		expect(verdictOf(rows(workload(), [tried, req, withdrawn]))).toEqual(no);
		expect(decideLaunch(rows(workload(), [tried, req, withdrawn]))).toEqual(no);
		expect(verdictOf(rows(workload(), [tried, done, req, withdrawn]))).toEqual(no);
		expect(verdictOf(rows(workload(), [withdrawn]))).toEqual(no);
		expect(verdictOf(rows(workload({ mode: "user-driven" }), [withdrawn]))).toEqual(no);
		expect(verdictOf(rows(workload({ holder: "jo" }), [withdrawn]))).toEqual(no);
		expect(verdictOf(rows(workload({ status: "closed" }), [withdrawn]))).toEqual({ launch: false, reason: "closed" });
		expect(verdictOf(rows(workload({ id: STANDING_WORKLOAD_ID }), [withdrawn]))).toEqual({ launch: false, reason: "standing" });
		expect(verdictOf(rows(workload({ brief: "due: remind me" }), [withdrawn]))).toEqual({ launch: false, reason: "due" });
		expect(launchable(workload(), control([tried, req]), null, [], NOW, 0, 3, false, true)).toEqual(no);
	});

	test("no withdrawal, or a forged one, keeps every verdict as before", () => {
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		const tried = launch("lane-m-1", "first");
		const forged = entry("lane-m-1", withdrawnBody("in-1"));
		expect(verdictOf(rows(workload(), [tried, req]))).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		expect(verdictOf(rows(workload(), [tried, req, forged]))).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		expect(verdictOf(rows(workload(), [tried, req, entry(SURFACE_BY, withdrawnBody("in-1"))], []))).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		expect(verdictOf(rows(workload({ mode: "user-driven" }), [forged]))).toEqual({ launch: false, reason: "user-driven" });
		expect(verdictOf(rows(workload(), [tried, entry("lane-m-1", "done-because: all done")]))).toEqual({ launch: false, reason: "awaiting-close" });
		expect(launchable(workload(), control([]), null, [], NOW, 0, 3)).toEqual({ launch: true, cause: { kind: "first" } });
	});

	test("decideInteractive: `as2 lane <wl>` refuses a withdrawn workload in either mode; closed, standing and due come first; none withdrawn decides as before", () => {
		const withdrawn = entry(SURFACE_BY, withdrawnBody("in-1"));
		const no = { launch: false, reason: "withdrawn" } as const;
		expect(decideInteractive(rows(workload({ mode: "user-driven" }), [withdrawn]))).toEqual(no);
		expect(decideInteractive(rows(workload(), [withdrawn]))).toEqual(no);
		expect(decideInteractive(rows(workload({ mode: "user-driven", status: "closed" }), [withdrawn]))).toEqual({ launch: false, reason: "closed" });
		expect(decideInteractive(rows(workload({ mode: "user-driven", id: STANDING_WORKLOAD_ID }), [withdrawn]))).toEqual({ launch: false, reason: "standing" });
		expect(decideInteractive(rows(workload({ mode: "user-driven", brief: "due: remind me" }), [withdrawn]))).toEqual({ launch: false, reason: "due" });
		expect(decideInteractive(rows(workload({ mode: "user-driven" }), []))).toEqual({ launch: true, cause: "interactive" });
		expect(decideInteractive(rows(workload({ mode: "user-driven" }), [entry("lane-m-1", withdrawnBody("in-1"))]))).toEqual({ launch: true, cause: "interactive" });
		expect(decideInteractive(rows(workload(), []))).toEqual({ launch: false, reason: "autonomous" });
		expect(decideInteractive(rows(workload({ mode: "user-driven", holder: "jo" }), []))).toEqual({ launch: false, reason: "held" });
	});
});

describe("plan approval by the auto-start's fixed writer (PLAN wl-mvfkv7llkp7nk0 § 3, R9)", () => {
	const first = () => entry(SURFACE_BY, planFirstBody("your word"));
	test("`plan: approved auto` approves only from ESCALATION_BY; ESCALATION_BY writes no other plan: line", () => {
		expect(planFirst(control([first(), entry(ESCALATION_BY, planAutoApprovedBody("dg-1"))]))).toBeNull();
		// A lane, the surface or any other writer forging the auto approval approves nothing, holder-aware or not.
		for (const by of ["lane-m-1", SURFACE_BY, LANE_RUNNER_BY]) {
			const rows = [first(), entry(by, planAutoApprovedBody("dg-1"))];
			expect(planFirst(control(rows, "lane-m-1"))).toMatchObject({ trigger: "your word" });
			expect(planFirst(controlEntries(rows))).toMatchObject({ trigger: "your word" });
		}
		expect(planFirst(control([first(), entry(ESCALATION_BY, "plan: approved in-1")]))).toMatchObject({ trigger: "your word" });
		expect(planFirst(control([first(), entry(ESCALATION_BY, planAutoApprovedBody("dg-1")), entry(ESCALATION_BY, planHaltedBody("in-1"))]))).toBeNull();
	});

	test("Jo's `plan: halted` stands the plan again until a later approve", () => {
		const halted = entry(SURFACE_BY, planHaltedBody("in-9"));
		const rows = [first(), entry(ESCALATION_BY, planAutoApprovedBody("dg-1")), halted];
		expect(planFirst(control(rows))).toEqual({ trigger: "halted by Jo (instruction in-9)", entryId: halted.id });
		expect(planFirst(control([...rows, entry(SURFACE_BY, "plan: approved in-10")]))).toBeNull();
		expect(planFirst(control([first(), entry("lane-m-1", planHaltedBody("in-9"))]))).toMatchObject({ trigger: "your word" });
	});
});

// ---- the merge train's own lane outside the cap (PLAN wl-mvpsrr4tr0p1xc D1, D2, D4) ----------------------------------

/** Minute `m` past 10:00 on the fixture day, with `ms` milliseconds: explicit times, so order never rests on `seq`. */
const T = (m: number, ms = 0) => `2026-10-01T10:${String(m).padStart(2, "0")}:00.${String(ms).padStart(3, "0")}Z`;
let tseq = 0;
const row = (by: string, body: string, at: string): EntryRow =>
	({ id: `et-${++tseq}`, workload_id: "wl-m", slice_id: null, kind: "assumption", body, created_by: by, created_at: at } as EntryRow);
const attempt = (lane: string, at: string, cause = "first") => row(LANE_STARTER_BY, `launch: ${lane} cause ${cause} requested-by tick`, at);
const ready = (lane: string, readAt: string, at = readAt) => row(LANE_RUNNER_BY, laneReadyBody(lane, readAt), at);
const failed = (lane: string, at: string) => row(LANE_STARTER_BY, launchFailedBody(lane, "spawn", "omp exited 1"), at);
const exited = (lane: string, outcome: string, at: string) => row(LANE_RUNNER_BY, laneExitBody(lane, { code: 0, signal: null, outcome }), at);
const resolvedAt = (instructionId: string, laneId: string, createdAt: string): Resolution => ({ instructionId, questionId: "q1", laneId, kind: "answer", body: "yes", createdAt });

describe("cap-exempt launch predicate (PLAN wl-mvpsrr4tr0p1xc D1)", () => {
	test("a cap-exempt workload skips only the cap refusal: at or over the cap it launches; held, closed, user-driven, awaiting-close and died-not-relaunched stand", () => {
		expect(launchable(workload(), [], null, [], NOW, 3, 3)).toEqual({ launch: false, reason: "cap" });
		expect(launchable(workload(), [], null, [], NOW, 3, 3, true)).toEqual({ launch: true, cause: { kind: "first" } });
		expect(launchable(workload(), [], null, [], NOW, 7, 3, true)).toEqual({ launch: true, cause: { kind: "first" } });
		const live = workload({ holder: "lane-m-1", holder_lease_until: "2026-10-01T10:05:00.000Z" });
		expect(launchable(live, control([], live.holder), null, [], NOW, 7, 3, true)).toEqual({ launch: false, reason: "held" });
		expect(launchable(workload({ status: "closed" }), [], null, [], NOW, 7, 3, true)).toEqual({ launch: false, reason: "closed" });
		expect(launchable(workload({ mode: "user-driven" }), [], null, [], NOW, 7, 3, true)).toEqual({ launch: false, reason: "user-driven" });
		expect(launchable(workload(), [], "the train is empty", [], NOW, 7, 3, true)).toEqual({ launch: false, reason: "awaiting-close" });
		expect(launchable(workload(), control([attempt("lane-m-1", T(1))]), null, [], NOW, 7, 3, true)).toEqual({ launch: false, reason: "died-not-relaunched" });
	});

	test("verdictOf passes the rows' capExempt through", () => {
		const rows = (capExempt: boolean): ReserveRows => ({
			workload: workload(), entries: [], questions: [], instructions: [], slices: [], holders: [], liveLanes: 3, capExempt, cap: 3, now: NOW,
		});
		expect(verdictOf(rows(false))).toEqual({ launch: false, reason: "cap" });
		expect(verdictOf(rows(true))).toEqual({ launch: true, cause: { kind: "first" } });
	});
});

describe("cap-exempt consumption: a resolution is spent only by a ready lane's prompt (PLAN wl-mvpsrr4tr0p1xc D2)", () => {
	const answer = resolvedAt("in-1", "lane-m-1", T(5));
	const base = () => [attempt("lane-m-1", T(1)), attempt("lane-m-2", T(6), "resume in-1")];
	const verdict = (entries: EntryRow[], capExempt: boolean) => launchable(workload(), control(entries), null, [answer], NOW, 0, 3, capExempt);

	test("a resume attempt that never got ready consumes nothing for the train; elsewhere naming the id consumes it, as today", () => {
		expect(verdict(base(), false)).toEqual({ launch: false, reason: "died-not-relaunched" });
		expect(verdict(base(), true)).toEqual({ launch: true, cause: { kind: "resume", ids: ["in-1"] } });
		expect(verdict([...base(), failed("lane-m-2", T(7))], true)).toEqual({ launch: true, cause: { kind: "resume", ids: ["in-1"] } });
	});

	test("a launched lane's lane-ready: later than the instruction consumes it, whatever cause the attempt named; the same millisecond does not", () => {
		expect(verdict([...base(), ready("lane-m-2", T(5, 1))], true)).toEqual({ launch: false, reason: "died-not-relaunched" });
		expect(verdict([...base(), ready("lane-m-2", T(5))], true)).toEqual({ launch: true, cause: { kind: "resume", ids: ["in-1"] } });
		// a first-cause lane that got ready after the answer carried it in its prompt too
		expect(verdict([attempt("lane-m-1", T(1)), ready("lane-m-1", T(8))], true)).toEqual({ launch: false, reason: "died-not-relaunched" });
	});

	test("the time is the body's row cut, not the entry's write time; a lane-ready: of a lane no launch: named counts for nothing", () => {
		// read before the answer, written after it: the prompt did not carry the answer
		expect(verdict([...base(), ready("lane-m-2", T(4), T(9))], true)).toEqual({ launch: true, cause: { kind: "resume", ids: ["in-1"] } });
		expect(verdict([...base(), ready("lane-m-9", T(9))], true)).toEqual({ launch: true, cause: { kind: "resume", ids: ["in-1"] } });
		expect(consumedByReady(control([...base(), ready("lane-m-2", T(9))]), T(5))).toBe(true);
		expect(consumedByReady(control([...base(), ready("lane-m-2", T(9))]), T(9))).toBe(false);
		expect(consumedByReady(control(base()), T(5))).toBe(false);
	});
});

describe("trainLaunchFailures: consecutive train launches that never got ready (PLAN wl-mvpsrr4tr0p1xc D4)", () => {
	const LATER = "2026-10-01T11:00:00.000Z";
	const rows = (entries: EntryRow[], over: Partial<TrainLaunchRows> = {}): TrainLaunchRows =>
		({ entries, instructions: [], questions: [], holder: null, holderLeaseUntil: null, now: LATER, ...over });
	const threeFailed = () => [
		attempt("lane-m-1", T(1)), failed("lane-m-1", T(2)),
		attempt("lane-m-2", T(3)), exited("lane-m-2", "never-ready", T(4)),
		attempt("lane-m-3", T(5)), failed("lane-m-3", T(6)),
	];

	test("the limit is 3 and the D4 question's options are relaunch / stop, never retry", () => {
		expect(TRAIN_LAUNCH_LIMIT).toBe(3);
		expect([...TRAIN_LAUNCH_OPTIONS]).toEqual(["relaunch", "stop"]);
	});

	test("launch-failed:, a never-ready exit, a superseded attempt and a dead newest attempt each count; the walk stops at a lane that got ready", () => {
		const entries = [
			attempt("lane-m-1", T(1)), ready("lane-m-1", T(2)), exited("lane-m-1", "completed", T(3)),
			attempt("lane-m-2", T(4)), failed("lane-m-2", T(5)),
			attempt("lane-m-3", T(6)), exited("lane-m-3", "never-ready", T(7)),
			attempt("lane-m-4", T(8)),
			attempt("lane-m-5", T(9)),
		];
		const f = trainLaunchFailures(rows(entries));
		expect(f.count).toBe(4);
		expect(f.lanes).toEqual(["lane-m-2", "lane-m-3", "lane-m-4", "lane-m-5"]);
		expect(f.first).toBe(T(4));
		expect(f.last).toBe(T(9));
		expect(f.failures).toHaveLength(4);
		expect(f.failures[0]).toStartWith(`lane-m-2 (${T(4)}): launch-failed:`);
		expect(f.failures[1]).toBe(`lane-m-3 (${T(6)}): lane-exit: outcome never-ready`);
		expect(f.failures[2]).toStartWith(`lane-m-4 (${T(8)}): no lane-ready:, superseded by lane-m-5`);
		expect(f.failures[3]).toStartWith(`lane-m-5 (${T(9)}): no lane-ready:`);
	});

	test("the newest attempt held by its lane under a live lease is in flight and not counted; lapsed, or held by another, it counts", () => {
		const entries = [attempt("lane-m-1", T(1)), attempt("lane-m-2", T(2))];
		expect(trainLaunchFailures(rows(entries, { holder: "lane-m-2", holderLeaseUntil: "2026-10-01T11:05:00.000Z" })).lanes).toEqual(["lane-m-1"]);
		expect(trainLaunchFailures(rows(entries, { holder: "lane-m-2", holderLeaseUntil: "2026-10-01T10:30:00.000Z" })).lanes).toEqual(["lane-m-1", "lane-m-2"]);
		expect(trainLaunchFailures(rows(entries, { holder: "jo", holderLeaseUntil: null })).lanes).toEqual(["lane-m-1", "lane-m-2"]);
		expect(trainLaunchFailures(rows([]))).toEqual({ count: 0, lanes: [], failures: [], first: null, last: null });
	});

	test("a by-hand attempt (`cause interactive`, no runner lane-ready:) never counts and ends the walk as a ready one does (lane decision en-mvpx8gfkld6ku8)", () => {
		const byHand = (lane: string, at: string, exitAt: string) => [
			attempt(lane, at, "interactive"), row(LANE_STARTER_BY, laneExitBody(lane, { code: 0, signal: null, outcome: "interactive" }), exitAt),
		];
		const three = [...byHand("lane-m-1", T(1), T(2)), ...byHand("lane-m-2", T(3), T(4)), ...byHand("lane-m-3", T(5), T(6))];
		expect(trainLaunchFailures(rows(three))).toEqual({ count: 0, lanes: [], failures: [], first: null, last: null });
		// failures before a by-hand session are behind it; a failure after it counts from one
		expect(trainLaunchFailures(rows([...threeFailed(), ...byHand("lane-m-4", T(7), T(8))])).count).toBe(0);
		expect(trainLaunchFailures(rows([...byHand("lane-m-1", T(1), T(2)), attempt("lane-m-2", T(3)), failed("lane-m-2", T(4))])).lanes).toEqual(["lane-m-2"]);
	});

	test("Jo's launch word resets the count; the tick's request does not, and a backlog of Jo requests before the failures resets nothing", () => {
		const jo = (at: string) => row(SURFACE_BY, launchRequestedBody("jo", at), at);
		const tick = (at: string) => row(MERGE_TRAIN_BY, launchRequestedBody("merge-train", at), at);
		expect(trainLaunchFailures(rows(threeFailed())).count).toBe(3);
		expect(trainLaunchFailures(rows([...threeFailed(), jo(T(7))])).count).toBe(0);
		expect(trainLaunchFailures(rows([...threeFailed(), jo(T(7)), attempt("lane-m-4", T(8)), failed("lane-m-4", T(9))])).lanes).toEqual(["lane-m-4"]);
		expect(trainLaunchFailures(rows([...threeFailed(), tick(T(7))])).count).toBe(3);
		expect(trainLaunchFailures(rows([jo(T(0)), jo(T(0, 5)), ...threeFailed()])).count).toBe(3);
		// a request written in the same millisecond as an attempt, before it in entry order, resets only what precedes it
		expect(trainLaunchFailures(rows([...threeFailed(), jo(T(7)), attempt("lane-m-4", T(7)), failed("lane-m-4", T(8))])).lanes).toEqual(["lane-m-4"]);
	});

	test("Jo's relaunch answer to the tick's D4 question resets; a stop answer, a lane's question or an unanswered one does not", () => {
		const question = (over: Partial<QuestionRow> = {}): QuestionRow => ({
			id: "q-d4", workload_id: "wl-m", slice_id: "sl-1", body: "train launch limit", options: JSON.stringify(TRAIN_LAUNCH_OPTIONS), state: "answered",
			resolved_by: "in-a", created_by: MERGE_TRAIN_BY, created_at: T(7), changed_by: SURFACE_BY, changed_at: T(8), rev: 1, ...over,
		});
		const answerRow = (body: string): InstructionRow => ({
			id: "in-a", workload_id: "wl-m", slice_id: "sl-1", kind: "answer", question_id: "q-d4", disposition: null, channel: "surface", author: "jo", body,
			created_by: SURFACE_BY, created_at: T(8),
		} as InstructionRow);
		const count = (q: QuestionRow, body: string) => trainLaunchFailures(rows(threeFailed(), { questions: [q], instructions: [answerRow(body)] })).count;
		expect(count(question(), "relaunch")).toBe(0);
		expect(count(question(), "stop")).toBe(3);
		expect(count(question({ created_by: "lane-m-3" }), "relaunch")).toBe(3);
		expect(count(question({ state: "open", resolved_by: null }), "relaunch")).toBe(3);
	});

	test("a new train: binding resets the count", () => {
		const ins = { id: "in-t", workload_id: "wl-m", slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface", author: "jo",
			body: prBindingInstructionBody("train", "wl-m", [12]), created_by: SURFACE_BY, created_at: T(7) } as InstructionRow;
		const binding = row(SURFACE_BY, `train: 12 in-t`, T(7));
		expect(trainLaunchFailures(rows([...threeFailed(), binding], { instructions: [ins] })).count).toBe(0);
		// the entry naming no such instruction is no binding
		expect(trainLaunchFailures(rows([...threeFailed(), binding])).count).toBe(3);
	});
});

describe("priority pause: the state and its cause (PLAN wl-mv8wzytml878b4 D3, T4, T5)", () => {
	const X = "wl-x";
	const prio = `${PRIORITY_REASON_PREFIX}${X}`;
	const stopReq = (lane: string, reason: string, by = "rank") => entry(SURFACE_BY, laneStopRequestBody(lane, reason, by));
	const accept = (lane: string, ref: string) => entry(LANE_RUNNER_BY, laneStopAcceptedBody(lane, ref));
	const exit = (lane: string, outcome: string, reason: string | null) => entry(LANE_RUNNER_BY, laneExitBody(lane, { code: 0, signal: null, outcome, reason }));
	/** L ran (cause first, session s-1), was asked to stop for X, accepted, and exited outcome stop reason priority-for-X. */
	const paused = (lane = "lane-m-1", cause = "first") => {
		const req = stopReq(lane, prio);
		const ex = exit(lane, "stop", prio);
		return { rows: [launch(lane, cause), started(lane, `s-${lane}`), req, accept(lane, req.id), ex], req, ex };
	};
	const verdict = (rows: EntryRow[], over: Partial<WorkloadRow> = {}, live = 0, resolved: Resolution[] = []) =>
		launchable(workload(over), control(rows, over.holder ?? null), null, resolved, NOW, live, 3);

	test("T4: the accepted priority stop and its lane-exit reason priority-for-X make the workload priority-paused", () => {
		const { rows, ex } = paused();
		expect(priorityPausedOf(control(rows))).toEqual({ laneId: "lane-m-1", forWl: X, exitId: ex.id });
		expect(priorityPausingOf(control(rows))).toBeNull();
	});

	test("T4: while the request is pending (accepted or not, no exit yet) it is priority-pausing, not paused", () => {
		const req = stopReq("lane-m-1", prio);
		const pending = [launch("lane-m-1", "first"), started("lane-m-1", "s-1"), req];
		expect(priorityPausingOf(control(pending))).toEqual({ laneId: "lane-m-1", forWl: X, requestId: req.id });
		expect(priorityPausedOf(control(pending))).toBeNull();
		const acceptedOnly = [...pending, accept("lane-m-1", req.id)];
		expect(priorityPausingOf(control(acceptedOnly))).toEqual({ laneId: "lane-m-1", forWl: X, requestId: req.id });
		expect(priorityPausedOf(control(acceptedOnly))).toBeNull();
	});

	test("T4: not paused after a ceiling stop, Jo's as2 lane stop (by-hand), a death, or a death before a late acceptance", () => {
		const base = [launch("lane-m-1", "first"), started("lane-m-1", "s-1")];
		const ceiling = [...base, accept("lane-m-1", "ceiling"), exit("lane-m-1", "stop", "ceiling")];
		const jo = stopReq("lane-m-1", "by-hand", "jo");
		const byHand = [...base, jo, accept("lane-m-1", jo.id), exit("lane-m-1", "stop", "by-hand")];
		const death = [...base, exit("lane-m-1", "died", null)];
		const req = stopReq("lane-m-1", prio);
		const lateAccept = [...base, req, exit("lane-m-1", "died", null), accept("lane-m-1", req.id)];
		for (const rows of [ceiling, byHand, death, lateAccept]) expect(priorityPausedOf(control(rows))).toBeNull();
		for (const rows of [ceiling, byHand, death, lateAccept]) expect(verdict(rows)).toEqual({ launch: false, reason: "died-not-relaunched" });
		expect(priorityPausingOf(control(lateAccept))).toBeNull();
	});

	test("T4: an exit reason priority-for-X counts only with the accepted request naming the same X, by a valid writer", () => {
		const other = stopReq("lane-m-1", `${PRIORITY_REASON_PREFIX}wl-y`);
		const mismatch = [launch("lane-m-1", "first"), other, accept("lane-m-1", other.id), exit("lane-m-1", "stop", prio)];
		expect(priorityPausedOf(control(mismatch))).toBeNull();
		const forged = entry("lane-m-1", laneStopRequestBody("lane-m-1", prio, "rank"));
		const lane = [launch("lane-m-1", "first"), forged, accept("lane-m-1", forged.id), exit("lane-m-1", "stop", prio)];
		expect(priorityPausedOf(control(lane))).toBeNull();
	});

	test("T5: a priority-paused workload launches with cause priority <exit id>, resuming the paused lane's own session", () => {
		const { rows, ex } = paused();
		expect(verdict(rows)).toEqual({ launch: true, cause: { kind: "priority", exitId: ex.id } });
		const relaunched = [...rows, launch("lane-m-2", `priority ${ex.id}`)];
		expect(resumePlan(control(relaunched), "lane-m-2", [], null)).toEqual({ resume: "s-lane-m-1", skipped: null });
	});

	test("T5: after one launch, whatever its cause (priority, Jo's request, an answered question), no priority cause is left", () => {
		const { rows, ex } = paused();
		expect(verdict([...rows, launch("lane-m-2", `priority ${ex.id}`)])).toEqual({ launch: false, reason: "died-not-relaunched" });
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		expect(verdict([...rows, req, launch("lane-m-2", `request ${req.id}`)])).toEqual({ launch: false, reason: "died-not-relaunched" });
		const answered = [...rows, launch("lane-m-2", "resume in-1")];
		expect(verdict(answered, {}, 0, [resolution("in-1", "lane-m-1")])).toEqual({ launch: false, reason: "died-not-relaunched" });
	});

	test("T5: precedence: a pending request is the cause taken; a done-because: gives awaiting-close; a live holder held; cap before it", () => {
		const { rows } = paused();
		const req = entry(SURFACE_BY, `launch-requested: by jo at ${NOW}`);
		expect(verdict([...rows, req])).toEqual({ launch: true, cause: { kind: "request", id: req.id } });
		const withReceipt = [...rows, entry("lane-m-1", "done-because: all done")];
		const reserve: ReserveRows = {
			workload: workload(), entries: withReceipt, questions: [], instructions: [], slices: [], holders: [], liveLanes: 0, capExempt: false, cap: 3, now: NOW,
		};
		expect(verdictOf(reserve)).toEqual({ launch: false, reason: "awaiting-close" });
		expect(verdict(rows, { holder: "lane-m-2", holder_lease_until: "2026-10-01T10:05:00.000Z" })).toEqual({ launch: false, reason: "held" });
		expect(verdict(rows, {}, 3)).toEqual({ launch: false, reason: "cap" });
	});

	test("T5: a second pause after the priority relaunch stands again, with its own exit id", () => {
		const first = paused();
		const second = paused("lane-m-2", `priority ${first.ex.id}`);
		const rows = [...first.rows, ...second.rows];
		expect(priorityPausedOf(control(rows))).toEqual({ laneId: "lane-m-2", forWl: X, exitId: second.ex.id });
		expect(verdict(rows)).toEqual({ launch: true, cause: { kind: "priority", exitId: second.ex.id } });
	});
});

describe("land-first rows: writers and activation (PLAN wl-mvq4edbaf13vnk D12, R32, R33)", () => {
	let t = 0;
	const at = () => `2026-10-27T10:${String(++t).padStart(2, "0")}:00.000Z`;
	const row = (by: string, body: string): EntryRow => ({ ...entry(by, body), workload_id: STANDING_WORKLOAD_ID, created_at: at() } as EntryRow);
	const jo = (id: string, body: string, over: Partial<InstructionRow> = {}): InstructionRow => ({
		id, workload_id: STANDING_WORKLOAD_ID, slice_id: null, kind: "instruction", question_id: null, disposition: null, channel: "surface", author: "jo", body,
		created_by: SURFACE_BY, created_at: NOW, ...over,
	} as InstructionRow);

	test("each new prefix counts only from its one writer", () => {
		const writers: [string, string][] = [
			[landFirstBody("agent-system-2.0", true, "in-1"), SURFACE_BY],
			[mainRetryBody("agent-system-2.0", "in-1"), SURFACE_BY],
			["train-reconciled: pr 17 merged", MERGE_TRAIN_BY],
			[`runner-preflight: ok source ${"a".repeat(40)} root /r`, TEST_RUNNER_BY],
		];
		for (const [body, writer] of writers) {
			for (const by of [SURFACE_BY, MERGE_TRAIN_BY, TEST_RUNNER_BY, "lane-m-1", ESCALATION_BY]) {
				expect(controlEntries([row(by, body)]).length).toBe(by === writer ? 1 : 0);
			}
			// a lane holding the workload cannot write one either
			expect(controlEntries([row("lane-m-1", body)], ["lane-m-1"])).toEqual([]);
			expect<string | null>(reservedPrefix(body)).toBe(body.slice(0, body.indexOf(":")));
		}
	});

	test("landFirstOn: off with no entry; the newest valid entry wins; an entry naming a forged or mismatched instruction is skipped", () => {
		const instructions = [jo("in-1", landFirstInstructionBody("agent-system-2.0", true)), jo("in-2", landFirstInstructionBody("agent-system-2.0", false))];
		expect(landFirstOn([], instructions, "agent-system-2.0")).toBe(false);
		const onRow = row(SURFACE_BY, landFirstBody("agent-system-2.0", true, "in-1"));
		const offRow = row(SURFACE_BY, landFirstBody("agent-system-2.0", false, "in-2"));
		expect(landFirstOn([onRow], instructions, "agent-system-2.0")).toBe(true);
		expect(landFirstOn([onRow, offRow], instructions, "agent-system-2.0")).toBe(false);
		// newest says on but names the off instruction: skipped, the older off stands
		expect(landFirstOn([onRow, offRow, row(SURFACE_BY, landFirstBody("agent-system-2.0", true, "in-2"))], instructions, "agent-system-2.0")).toBe(false);
		// newest names an instruction that is not there
		expect(landFirstOn([offRow, row(SURFACE_BY, landFirstBody("agent-system-2.0", true, "in-9"))], instructions, "agent-system-2.0")).toBe(false);
		// an instruction an agent wrote, or one not authored by Jo, is no word of Jo's
		for (const over of [{ created_by: "lane-m-1" }, { author: "orchestrator" }, { kind: "answer" as const }, { workload_id: "wl-m" }]) {
			expect(landFirstOn([row(SURFACE_BY, landFirstBody("agent-system-2.0", true, "in-7"))], [jo("in-7", landFirstInstructionBody("agent-system-2.0", true), over)], "agent-system-2.0")).toBe(false);
		}
	});

	test("repositories match by owner/name or name, case-insensitively, never by prefix", () => {
		expect(sameRepo("agent-system-2.0", "thewolff/agent-system-2.0")).toBe(true);
		expect(sameRepo("TheWolff/Agent-System-2.0", "thewolff/agent-system-2.0")).toBe(true);
		expect(sameRepo("system-2.0", "thewolff/agent-system-2.0")).toBe(false);
		expect(sameRepo("other/agent-system-2.0", "thewolff/agent-system-2.0")).toBe(false);
		const instructions = [jo("in-1", landFirstInstructionBody("agent-system-2.0", true)), jo("in-2", mainRetryInstructionBody("newdle-web"))];
		const rows = [row(SURFACE_BY, landFirstBody("agent-system-2.0", true, "in-1")), row(SURFACE_BY, mainRetryBody("newdle-web", "in-2"))];
		expect(landFirstOn(rows, instructions, "thewolff/agent-system-2.0")).toBe(true);
		expect(landFirstOn(rows, instructions, "thewolff/newdle-web")).toBe(false);
		expect(mainRetries(rows, instructions, "thewolff/newdle-web")).toEqual([rows[1]!.created_at]);
		expect(mainRetries(rows, instructions, "agent-system-2.0")).toEqual([]);
	});
});
