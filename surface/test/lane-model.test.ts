// Jo names the model a workload's lanes run on (MIGRATION.md item 85; PLAN wl-mv45mh3byhixog v3): the
// `model` param of the open and launch tools, the `lane-model:` control line, `--model` in both argvs,
// the session kept only on the same model, the get_state check that gates readiness, the prompt error
// in the death line, and the lane's own forgery refused. The runner rows that spawn the fake omp are
// in lane-model-script.test.ts.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EntryRow, LANE_RUNNER_BY, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import {
	controlEntries, doneBody, interactiveArgv, laneArgv, laneModel, laneModelBody, modelProblem, type Resolution, resumePlan, stateModelCheck, stateModelOf,
} from "../src/launch";
import { promptEndedDeathBody, promptErrorOf, turnEnd, turnEndDeathBody, type TurnEndInput } from "../src/turn-end";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const A = "anthropic/claude-opus-5-5";
const X = "openai-codex/gpt-6-sol";
const NOW = "2026-10-01T09:00:00.000Z";

let seq = 0;
const entry = (by: string, body: string): EntryRow => ({
	id: `e-${++seq}`, workload_id: "wl-m", slice_id: null, kind: "assumption", body, created_by: by, created_at: `2026-10-01T09:${String(seq % 60).padStart(2, "0")}:00.000Z`,
} as EntryRow);
const launch = (lane: string, cause: string) => entry(LANE_STARTER_BY, `launch: ${lane} cause ${cause} requested-by jo`);
/** A runner `lane-started:`; `model` undefined writes a legacy entry with no model field. */
const started = (lane: string, session: string | null, model?: string | null) =>
	entry(LANE_RUNNER_BY, `lane-started: ${lane} ${JSON.stringify({ pid: 1, start: "x", session, argv: [], runnerPid: 2, ...(model !== undefined ? { model } : {}) })}`);
const named = (sel: string) => entry(SURFACE_BY, laneModelBody(sel, NOW));
const resolution = (instructionId: string, laneId: string): Resolution => ({ instructionId, questionId: "q1", laneId, kind: "answer", body: "yes", createdAt: NOW });
const SPEC = { worktree: "/w", sessionDir: "/s", systemPromptPath: "/p" };

function orchestratorEnv(): Record<string, string> {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE");
	const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false }).close();
	return e;
}

/** The orchestrator surface on a fresh ledger, with no exec (the launcher is never run), and a call helper. */
function surface() {
	const e = orchestratorEnv();
	const f = fakePi();
	orchestratorSurface(f.pi, e, {});
	const call = async (tool: string, params: Record<string, unknown>) => {
		const r = await f.tool(tool).execute("1", params, undefined, undefined, ctxOf());
		return { text: r.content[0]!.text, details: r.details as Record<string, unknown> | undefined };
	};
	const ledger = () => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false, backupOnOpen: false });
	return { call, ledger };
}

describe("T1/T2: Jo's lane-model: line and the argv", () => {
	test("T1u: the open tool records Jo's model as the surface; laneArgv carries --model after --max-time, before --resume", async () => {
		const s = surface();
		const r = await s.call("orchestrator_open_workload", { brief: "move the header offset into a token", done: "it is done", stakes: "normal", model: X });
		const id = String(r.details?.id);
		expect(r.text).toContain(`lane model: ${X}`);
		const l = s.ledger();
		const control = controlEntries(l.entries(id, "assumption"));
		l.close();
		const lines = control.filter((c) => c.prefix === "lane-model");
		expect(lines.length).toBe(1);
		expect(lines[0]!.createdBy).toBe(SURFACE_BY);
		expect(laneModel(control)).toBe(X);
		const argv = laneArgv({ ...SPEC, maxTime: "6h", resume: "/one.jsonl", model: laneModel(control) });
		expect(argv.slice(-6)).toEqual(["--max-time", "6h", "--model", X, "--resume", "/one.jsonl"]);
		expect(laneArgv({ ...SPEC, maxTime: "6h", resume: null, model: null })).not.toContain("--model");
	});

	test("T1u: the launch tool writes lane-model: in the launch-requested: transaction, model first", async () => {
		const s = surface();
		const id = String((await s.call("orchestrator_open_workload", { brief: "move the header offset into a token", done: "it is done", stakes: "normal" })).details?.id);
		const r = await s.call("orchestrator_launch_lane", { workloadId: id, model: X, reason: "relaunch on openai" });
		expect(r.text).toContain(`with lane model ${X}`);
		const l = s.ledger();
		const control = controlEntries(l.entries(id, "assumption"));
		l.close();
		const order = control.filter((c) => c.prefix === "lane-model" || c.prefix === "launch-requested").map((c) => c.prefix);
		expect(order).toEqual(["lane-model", "launch-requested"]);
		expect(laneModel(control)).toBe(X);
	});

	test("T2u: the newest valid lane-model: wins and is kept until changed; default clears it; a malformed one is skipped", () => {
		const control = (rows: EntryRow[]) => controlEntries(rows);
		expect(laneModel(control([]))).toBeNull();
		expect(laneModel(control([named(A), launch("lane-m-1", "first"), started("lane-m-1", "/one", A), named(X), started("lane-m-2", "/two", X)]))).toBe(X);
		expect(laneModel(control([named(X), entry(SURFACE_BY, "launch-requested: by jo at t")]))).toBe(X);
		expect(laneModel(control([named(X), named("default")]))).toBeNull();
		expect(laneModel(control([named(X), entry(SURFACE_BY, `lane-model: opus by jo at ${NOW}`)]))).toBe(X);
	});
});

describe("T3/T8: the session is resumed only on the model it ran on", () => {
	const control = (rows: EntryRow[]) => controlEntries(rows);

	test("T3: a relaunch on B after a lane on A starts fresh and names A's session; on A it resumes", () => {
		const c = control([launch("lane-m-1", "first"), started("lane-m-1", "/one", A), launch("lane-m-2", "request e-9")]);
		expect(resumePlan(c, "lane-m-2", [], X)).toEqual({ resume: null, skipped: `/one ran on ${A}` });
		expect(resumePlan(c, "lane-m-2", [], A)).toEqual({ resume: "/one", skipped: null });
		expect(resumePlan(c, "lane-m-2", [], null)).toEqual({ resume: null, skipped: `/one ran on ${A}` });
		expect(interactiveArgv({ ...SPEC, model: X, resume: null, firstPromptPath: "/l/prompt.md" })).toEqual(["--cwd", "/w", "--session-dir", "/s", "--append-system-prompt", "/p", "--model", X, "@/l/prompt.md"]);
	});

	test("T3b: a session only lane-parked: recorded keeps its lane's model; with no lane-started: at all it is unknown", () => {
		const parked = entry(LANE_RUNNER_BY, "lane-parked: lane-m-1 questions q1 session /parked.jsonl");
		const c = control([launch("lane-m-1", "first"), started("lane-m-1", null, A), parked, launch("lane-m-2", "resume in-1")]);
		const resolved = [resolution("in-1", "lane-m-1")];
		expect(resumePlan(c, "lane-m-2", resolved, A)).toEqual({ resume: "/parked.jsonl", skipped: null });
		expect(resumePlan(c, "lane-m-2", resolved, X)).toEqual({ resume: null, skipped: `/parked.jsonl ran on ${A}` });
		expect(resumePlan(control([parked]), "lane-m-2", [], null)).toEqual({ resume: null, skipped: "/parked.jsonl ran on unknown" });
	});

	test("T3c: a resume cause takes the raising lane's session and model past a newer lane on B", () => {
		const c = control([
			launch("lane-m-1", "first"), started("lane-m-1", "/one", A), launch("lane-m-2", "request e-9"), started("lane-m-2", "/two", X), launch("lane-m-3", "resume in-1"),
		]);
		expect(resumePlan(c, "lane-m-3", [resolution("in-1", "lane-m-1")], A)).toEqual({ resume: "/one", skipped: null });
		expect(resumePlan(c, "lane-m-3", [resolution("in-1", "lane-m-1")], X)).toEqual({ resume: null, skipped: `/one ran on ${A}` });
	});

	test("T3d: a legacy lane-started: with no model field ran on the default", () => {
		const c = control([launch("lane-m-1", "first"), started("lane-m-1", "/one"), launch("lane-m-2", "request e-9")]);
		expect(resumePlan(c, "lane-m-2", [], null)).toEqual({ resume: "/one", skipped: null });
		expect(resumePlan(c, "lane-m-2", [], X)).toEqual({ resume: null, skipped: "/one ran on default" });
	});

	test("T8a: named then cleared, the X lane holding the newest session: neither --model nor --resume, s2 named", () => {
		const c = control([
			launch("lane-m-1", "first"), started("lane-m-1", "/s1", null), named(X), launch("lane-m-2", "request e-1"), started("lane-m-2", "/s2", X),
			named("default"), launch("lane-m-3", "request e-2"),
		]);
		const model = laneModel(c);
		expect(model).toBeNull();
		const plan = resumePlan(c, "lane-m-3", [], model);
		expect(plan).toEqual({ resume: null, skipped: `/s2 ran on ${X}` });
		const argv = laneArgv({ ...SPEC, maxTime: "6h", resume: plan.resume, model });
		expect(argv).not.toContain("--model");
		expect(argv).not.toContain("--resume");
		expect(argv).not.toContain("default");
		expect(interactiveArgv({ ...SPEC, model, resume: plan.resume, firstPromptPath: "/l/prompt.md" })).toEqual(["--cwd", "/w", "--session-dir", "/s", "--append-system-prompt", "/p", "@/l/prompt.md"]);
	});

	test("T8b: named then cleared, the X launch failing before a session: default resumes the default-era s1", () => {
		const c = control([
			launch("lane-m-1", "first"), started("lane-m-1", "/s1", null), named(X), launch("lane-m-2", "request e-1"), started("lane-m-2", null, X),
			entry(LANE_RUNNER_BY, `launch-failed: lane-m-2 model: named ${X}, get_state failed: fake`), named("default"), launch("lane-m-3", "request e-2"),
		]);
		expect(resumePlan(c, "lane-m-3", [], laneModel(c))).toEqual({ resume: "/s1", skipped: null });
	});
});

describe("T4: get_state must report exactly the named provider/id", () => {
	const state = (model: unknown, extra: Record<string, unknown> = {}) => ({ id: "state", type: "response", command: "get_state", success: true, data: { model, isSettled: true, ...extra } });

	test("T4u: a match passes; another model fails with both names", () => {
		expect(stateModelCheck(X, state({ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6-Sol" }))).toEqual({ ok: true, ran: X });
		expect(stateModelCheck(X, state({ provider: "anthropic", id: "claude-opus-5-5" }))).toEqual({ ok: false, reason: `named ${X}, omp started ${A}` });
		// one lab, two providers: openai is not openai-codex
		expect(stateModelCheck(X, state({ provider: "openai", id: "gpt-6-sol" }))).toEqual({ ok: false, reason: `named ${X}, omp started openai/gpt-6-sol` });
		expect(stateModelOf(state({ provider: "openai-codex", id: "gpt-6-sol" }))).toBe(X);
	});

	test("T4b-u: a missing or partial model and a failed get_state each fail closed", () => {
		expect(stateModelCheck(X, state(undefined))).toEqual({ ok: false, reason: `named ${X}, get_state reported no provider/id model` });
		expect(stateModelCheck(X, state({ id: "fake" }))).toEqual({ ok: false, reason: `named ${X}, get_state reported no provider/id model` });
		expect(stateModelCheck(X, { id: "state", type: "response", command: "get_state", success: false, error: "fake get_state failure" }))
			.toEqual({ ok: false, reason: `named ${X}, get_state failed: fake get_state failure` });
		expect(stateModelCheck(X, { id: "state", type: "response", command: "get_state", success: false })).toEqual({ ok: false, reason: `named ${X}, get_state failed: no error given` });
		expect(stateModelOf({ success: false })).toBeNull();
		expect(stateModelOf(state({ id: "fake" }))).toBeNull();
	});
});

describe("PLAN wl-mv71x5rwdu7eo0 § 4: lane-headroom: is the runner's record, never Jo's word", () => {
	// A literal (surface/src/launch.ts laneHeadroomBody's shape), so this file still loads on a baseline without it.
	const body = `lane-headroom: lane-m-1 ${A} -> openai-codex/gpt-6.1-sol (anthropic 5h 0.85 used > 0.80)`;

	test("honoured from the runner only, lane-scoped; laneModel reads lane-model: alone, so a move never names the workload's model", () => {
		const c = controlEntries([named(X), entry(LANE_RUNNER_BY, body)]);
		expect(c.map((e) => [e.prefix, e.laneId, e.createdBy])).toEqual([["lane-model", null, SURFACE_BY], ["lane-headroom", "lane-m-1", LANE_RUNNER_BY]]);
		expect(laneModel(c)).toBe(X);
		expect(laneModel(controlEntries([entry(LANE_RUNNER_BY, body)]))).toBeNull();
		for (const forger of [SURFACE_BY, LANE_STARTER_BY, "lane-m-1"]) expect(controlEntries([entry(forger, body)], ["lane-m-1"])).toEqual([]);
	});
});

describe("T6: the prompt's error rides the death line", () => {
	test("T6u: a refusal on prompt_result names provider/model, the message on one line, and retryable", () => {
		const frame = {
			type: "prompt_result", id: "p1", status: "error",
			error: { message: "Refusal (cyber):\n the request was declined", provider: "anthropic", model: "claude-opus-5-5", retryable: false },
		};
		const promptError = promptErrorOf(frame);
		expect(promptError).toEqual({ message: "Refusal (cyber):\n the request was declined", provider: "anthropic", model: "claude-opus-5-5", retryable: false });
		const input: TurnEndInput = {
			settled: true, idle: false, status: "error", unsettledHands: [], liveTestRuns: [], deadTestRuns: [], pendingReserved: false, held: true, handedOff: false, releasedOpen: null, receipt: false,
			slices: { open: 1, paused: 0, done: 0 }, continues: 0, idleContinues: 0, limit: 2, park: () => ({ parked: false }), promptError,
		};
		const t = turnEnd(input);
		expect(t.decision).toBe("error");
		expect(turnEndDeathBody("lane-m-1", t, input)).toBe("lane-died: lane-m-1: prompt ended error: anthropic/claude-opus-5-5: Refusal (cyber): the request was declined (retryable false)");
		expect(turnEndDeathBody("lane-m-1", t, { ...input, promptError: null })).toBe("lane-died: lane-m-1: prompt ended error");
		expect(promptEndedDeathBody("lane-m-1", "error", { message: "boom", provider: null, model: null, retryable: true })).toBe("lane-died: lane-m-1: prompt ended error: boom (retryable true)");
		expect(promptErrorOf({ type: "prompt_result", status: "error" })).toBeNull();
	});
});

describe("T7: a model Jo cannot name is refused with nothing written", () => {
	// "" and whitespace are a supplied value, not an omitted one: refused like any other bad selector.
	const BAD = ["opus", "foo/bar", "openai-codex/x:high", "", "   "];

	test("modelProblem names each failure; an exact selector on a known lab and default pass", () => {
		expect(modelProblem("opus")).toContain("not an exact provider/model selector");
		expect(modelProblem("foo/bar")).toContain("no known lab");
		expect(modelProblem("openai-codex/x:high")).toContain("`:level` suffix");
		expect(modelProblem(X)).toBeNull();
		expect(modelProblem("default")).toBeNull();
		expect(modelProblem("")).toContain("no model was named");
	});

	test("the open tool opens nothing; the launch tool writes nothing", async () => {
		const s = surface();
		for (const model of BAD) {
			const r = await s.call("orchestrator_open_workload", { brief: "move the header offset into a token", done: "it is done", stakes: "normal", model });
			expect(r.text).toContain("Nothing was opened.");
		}
		let l = s.ledger();
		expect(l.inFlight().length).toBe(0);
		l.close();
		const id = String((await s.call("orchestrator_open_workload", { brief: "move the header offset into a token", done: "it is done", stakes: "normal" })).details?.id);
		l = s.ledger();
		const before = l.entries(id).length;
		l.close();
		for (const model of BAD) expect((await s.call("orchestrator_launch_lane", { workloadId: id, model })).text).toContain("Nothing was written.");
		l = s.ledger();
		expect(l.entries(id).length).toBe(before);
		l.close();
	});

	test("on a user-driven workload the model is recorded and the by-hand line returned; nothing launches", async () => {
		const s = surface();
		const id = String((await s.call("orchestrator_open_workload", { brief: "move the header offset into a token", done: "it is done", stakes: "normal", mode: "user-driven" })).details?.id);
		const r = await s.call("orchestrator_launch_lane", { workloadId: id, model: X });
		expect(r.text).toContain(`Recorded lane model ${X}`);
		expect(r.text).toContain(`as2 lane ${id}`);
		const l = s.ledger();
		const control = controlEntries(l.entries(id, "assumption"));
		l.close();
		expect(laneModel(control)).toBe(X);
		expect(control.some((c) => c.prefix === "launch-requested")).toBe(false);
	});
});

describe("T9: a lane cannot name its own model", () => {
	test("a lane-written lane-model: is ignored, and lane_record_entry refuses the body", async () => {
		const forged = entry("lane-m-1", laneModelBody(X, NOW));
		expect(laneModel(controlEntries([named(A), forged]))).toBe(A);

		const { ledger, path } = tempLedger();
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the header offset lives in one token") });
		ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
		const f = fakePi(undefined, { exec: false });
		orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" }, {});
		const before = ledger.entries(wl).length;
		const r = await f.tool("lane_record_entry").execute("1", { body: laneModelBody(X, NOW) }, undefined, undefined, ctxOf());
		expect(r.content[0]!.text).toContain("`lane-model:` is a reserved control line");
		expect(ledger.entries(wl).length).toBe(before);
	});
});
