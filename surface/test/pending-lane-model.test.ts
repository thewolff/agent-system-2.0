// Jo's model must be recorded before a lane starts (PLAN wl-mv8d45mqycd8g0, D5 T1-T8): a paste carrying
// `lane model <provider/model> for <wl-…>` beside `autonomous <wl-…>` started the lane on the profile
// default before the orchestrator recorded the model. Driven through the fake host (its `exec` stands for
// the lane starter and records what the ledger held when it ran) and a real ledger in a temp dir. Only
// entry points that exist before the fix are imported, so on the baseline these fail on behaviour (a start
// that happened, a model that was not recorded), never on a missing module.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { launchVerdict } from "../extensions/launch";
import orchestratorSurface from "../index";
import { ensureStandingWorkload } from "../src/identity";
import { decideInteractive, decideLaunch, laneModelBody } from "../src/launch";
import { raiseOrchestratorQuestion } from "../src/orchestrator-question";
import { renderWake } from "../src/render";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const X = "openai-codex/gpt-6-sol";
const Y = "anthropic/claude-opus-5-5";
const RECORDER = "orchestrator_record_instruction";

/** The newest `lane-model:` selector the surface wrote on `wl`, or null: the model a lane started now would run on. */
const recordedModel = (ledger: Ledger, wl: string): string | null =>
	ledger.entries(wl, "assumption").filter((e) => e.created_by === SURFACE_BY && e.body.startsWith("lane-model: ")).at(-1)?.body.split(" ")[1] ?? null;

/** A surface over `path` (a fresh ledger when absent) with exec on: every starter run is recorded with the model the ledger held at that moment. */
function surface(o: { path?: string; ledger?: Ledger } = {}) {
	const { ledger, path } = o.path && o.ledger ? { ledger: o.ledger, path: o.path } : tempLedger();
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: true });
	/** Each starter run: the workload and the model recorded on it when the starter ran. */
	const starts: { wl: string; model: string | null }[] = [];
	f.execs.answer = (_command, args) => {
		if (args[1] === "launch") starts.push({ wl: args[2]!, model: recordedModel(ledger, args[2]!) });
		return { stdout: `lane lane-probe-1 runner 4242`, stderr: "", code: 0, killed: false };
	};
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf();
	/** Jo types `text` and it is the turn's prompt: OMP's `input`, then `before_agent_start`. */
	const type = async (text: string): Promise<void> => {
		await f.emit("input", { text, source: "interactive" }, ctx);
		await f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, ctx);
	};
	/** A prompt that reaches the turn without Jo having typed it (no `input` event): no Jo authority. */
	const untyped = async (text: string): Promise<void> => {
		await f.emit("before_agent_start", { prompt: text, systemPrompt: [] }, ctx);
	};
	const tool = async (name: string, params: Record<string, unknown>): Promise<string> => (await f.tool(name).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	/** The input id the surface echoed last (its `surface-jo-input` entry). */
	const lastInput = (): string => {
		const data = f.entries.filter((e) => e.type === "surface-jo-input").at(-1)?.data;
		if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "string") throw new Error("no input row was echoed");
		return data.id;
	};
	const record = (inputId: string, workloadId: string, reading = "run its lanes on the named model") => tool(RECORDER, { workloadId, inputId, reading });
	return { ledger, path, f, ctx, starts, type, untyped, tool, lastInput, record };
}

/** A workload Jo has not handed to lanes yet (user-driven), so `autonomous <wl>` is the flip that starts one. */
const openUserDriven = (ledger: Ledger, brief = "Probe the pending lane model"): string => ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "user-driven" });
const launchEntries = (ledger: Ledger, wl: string) => ledger.entries(wl, "assumption").filter((e) => e.body.startsWith("launch: "));
const reserve = (ledger: Ledger, wl: string, decide = decideLaunch) =>
	ledger.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 60_000, requestedBy: "test", receiptWorkload: STANDING_WORKLOAD_ID, decide });


describe("T1: the reported paste waits for the model, in either order, then starts on it", () => {
	for (const order of ["model first", "autonomous first"] as const) {
		test(`${order}: no starter run before the record; the recorder's commit carries Jo's model into the one start`, async () => {
			const t = surface();
			const wl = openUserDriven(t.ledger);
			const lines = [`lane model ${X} for ${wl}`, `autonomous ${wl}`];
			await t.type((order === "model first" ? lines : lines.reverse()).join("\n"));
			expect(t.ledger.workload(wl)!.mode).toBe("autonomous");
			expect(t.starts).toEqual([]);
			const input = t.lastInput();
			await t.record(input, wl);
			expect(t.starts).toEqual([{ wl, model: X }]);
		});
	}
});

describe("T2: every start route waits on a recorded-later model input", () => {
	test("standalone model input, then autonomous, explicit launch with and without model, the tick's verdict and a direct reservation all wait; one start after the record", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		await t.type(`autonomous ${wl}`);
		expect(t.ledger.workload(wl)!.mode).toBe("autonomous");
		expect(t.starts).toEqual([]);
		const entriesBefore = t.ledger.entries(wl).length;
		const plain = await t.tool("orchestrator_launch_lane", { workloadId: wl, reason: "go" });
		expect(plain).toStartWith("Refused: ");
		expect(plain).toContain(input);
		const conflicting = await t.tool("orchestrator_launch_lane", { workloadId: wl, model: Y });
		expect(conflicting).toStartWith("Refused: ");
		expect(t.ledger.entries(wl).length).toBe(entriesBefore);
		expect(recordedModel(t.ledger, wl)).toBeNull();
		expect(launchVerdict(t.ledger, {}, wl)?.launch).toBe(false);
		const direct = reserve(t.ledger, wl);
		expect(direct.ok).toBe(false);
		expect(direct.ok ? "" : direct.reason).toContain(input);
		expect(launchEntries(t.ledger, wl)).toEqual([]);
		expect(t.ledger.workload(wl)!.holder).toBeNull();
		expect(t.starts).toEqual([]);
		// Jo's flip is still the cause: recording the model is what starts it, once
		await t.record(input, wl);
		expect(t.starts).toEqual([{ wl, model: X }]);
		expect(launchVerdict(t.ledger, {}, wl)?.launch).toBe(true);
		expect(reserve(t.ledger, wl)).toMatchObject({ ok: true });
	});
});

describe("T3: only Jo's own words, recorded on their own workload, carry the model", () => {
	test("a wrong-target record writes nothing and leaves the authentic input pending; a model named only in the reading records no model", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		const other = openUserDriven(t.ledger, "Another workload");
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		const wrong = await t.record(input, other);
		expect(wrong).toContain("nothing was recorded");
		expect(t.ledger.instructions(other)).toEqual([]);
		expect(recordedModel(t.ledger, other)).toBeNull();
		await t.type(`autonomous ${wl}`);
		expect(t.starts).toEqual([]);
		// plain words recorded with a reading that names a model: the reading is never the model
		await t.type("go ahead with the other one");
		await t.record(t.lastInput(), other, `lane model ${Y} for ${other}`);
		expect(recordedModel(t.ledger, other)).toBeNull();
		expect(t.starts).toEqual([]);
		await t.record(input, wl);
		expect(t.starts).toEqual([{ wl, model: X }]);
	});

	test("forged model rows (another writer, author or channel) have no authority: the flip starts at once", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		ensureStandingWorkload(t.ledger);
		t.ledger.recordInstruction({ by: "lane-a", workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "jo", channel: "surface" });
		t.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "lane-a", channel: "surface" });
		t.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "jo", channel: "direct" });
		await t.type(`autonomous ${wl}`);
		expect(t.starts).toEqual([{ wl, model: null }]);
	});

	test("an invalid selector refuses the paste whole; the corrected paste then waits and records", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		const rowsBefore = t.ledger.instructions(STANDING_WORKLOAD_ID).length;
		await t.type(`autonomous ${wl}\nlane model gpt-6-sol for ${wl}`);
		expect(t.ledger.workload(wl)!.mode).toBe("user-driven");
		expect(t.ledger.instructions(STANDING_WORKLOAD_ID).length).toBe(rowsBefore);
		expect(t.starts).toEqual([]);
		await t.type(`autonomous ${wl}\nlane model ${X} for ${wl}`);
		expect(t.starts).toEqual([]);
		await t.record(t.lastInput(), wl);
		expect(t.starts).toEqual([{ wl, model: X }]);
	});
});

describe("T4: a refused paste leaves nothing behind; other workloads are not held", () => {
	test("a model line for a workload that is not open refuses: no flip, no input row, no pending model", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		const rowsBefore = t.ledger.instructions(STANDING_WORKLOAD_ID).length;
		await t.type(`autonomous ${wl}\nlane model ${X} for wl-nosuchworkload`);
		expect(t.ledger.workload(wl)!.mode).toBe("user-driven");
		expect(t.ledger.instructions(STANDING_WORKLOAD_ID).length).toBe(rowsBefore);
		await t.type(`autonomous ${wl}`);
		expect(t.starts).toEqual([{ wl, model: null }]);
	});

	test("an untyped model-bearing paste is refused before its commands apply", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.untyped(`autonomous ${wl}\nlane model ${X} for ${wl}`);
		expect(t.ledger.workload(wl)!.mode).toBe("user-driven");
		expect(t.starts).toEqual([]);
		expect(t.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([]);
	});

	test("workload B starts while A waits for its model; a model-free paste keeps its behaviour", async () => {
		const t = surface();
		const a = openUserDriven(t.ledger, "A");
		const b = openUserDriven(t.ledger, "B");
		await t.type(`lane model ${X} for ${a}`);
		await t.type(`autonomous ${a}\nautonomous ${b}\nthen carry on`);
		expect(t.starts).toEqual([{ wl: b, model: null }]);
		expect(t.ledger.workload(a)!.mode).toBe("autonomous");
	});
});

describe("T5: recording rules", () => {
	test("default clears the model only once recorded", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		t.ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: laneModelBody(X, t.ledger.now()) });
		await t.type(`lane model default for ${wl}`);
		expect(recordedModel(t.ledger, wl)).toBe(X);
		await t.record(t.lastInput(), wl);
		expect(recordedModel(t.ledger, wl)).toBe("default");
	});

	test("a user-driven workload's record starts nothing and the by-hand starter waits until then", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		const byHand = reserve(t.ledger, wl, decideInteractive);
		expect(byHand.ok ? "" : byHand.reason).toContain(input);
		await t.record(input, wl);
		expect(recordedModel(t.ledger, wl)).toBe(X);
		expect(t.starts).toEqual([]);
		expect(reserve(t.ledger, wl, decideInteractive)).toMatchObject({ ok: true });
	});

	test("a duplicate record is refused and starts nothing more", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		await t.type(`autonomous ${wl}`);
		await t.record(input, wl);
		expect(t.starts).toHaveLength(1);
		expect(await t.record(input, wl)).toContain("nothing was recorded");
		expect(t.starts).toHaveLength(1);
	});

	test("a newer model input supersedes an older unrecorded one: the stale record is refused naming it, the newer wins", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`lane model ${X} for ${wl}`);
		const older = t.lastInput();
		await t.type(`lane model ${Y} for ${wl}`);
		const newer = t.lastInput();
		await t.type(`autonomous ${wl}`);
		const stale = await t.record(older, wl);
		expect(stale).toContain(newer);
		expect(stale).toContain("nothing was recorded");
		expect(recordedModel(t.ledger, wl)).toBeNull();
		expect(t.starts).toEqual([]);
		await t.record(newer, wl);
		expect(t.starts).toEqual([{ wl, model: Y }]);
	});
});

describe("T6: the line grammar and durability", () => {
	test("the pending input survives a new surface session on the same ledger", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		const t2 = surface({ path: t.path, ledger: t.ledger });
		await t2.type(`autonomous ${wl}`);
		expect(t2.starts).toEqual([]);
		await t2.record(input, wl);
		expect(t2.starts).toEqual([{ wl, model: X }]);
	});

	test("upper case, a colon, a sentence period and a # comment are one model line: each paste applies, waits, and records its model", async () => {
		const t = surface();
		const a = openUserDriven(t.ledger, "A");
		const b = openUserDriven(t.ledger, "B");
		await t.type(`autonomous ${a}\nLANE MODEL: ${X} FOR ${a.toUpperCase()}.`);
		const forA = t.lastInput();
		await t.type(`autonomous ${b}\nlane model ${Y} for ${b} # the opus run`);
		const forB = t.lastInput();
		expect(forB).not.toBe(forA);
		expect([t.ledger.workload(a)!.mode, t.ledger.workload(b)!.mode]).toEqual(["autonomous", "autonomous"]);
		expect(t.starts).toEqual([]);
		await t.record(forA, a);
		await t.record(forB, b);
		expect(t.starts).toEqual([{ wl: a, model: X }, { wl: b, model: Y }]);
	});

	test("a quoted or narrative mention is prose: the flip starts at once", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger);
		await t.type(`autonomous ${wl}\nyesterday I wrote "lane model ${X} for ${wl}" somewhere`);
		expect(t.starts).toEqual([{ wl, model: null }]);
	});

	test("a near-miss model line or two workloads in one run refuses the paste", async () => {
		const t = surface();
		const a = openUserDriven(t.ledger, "A");
		const b = openUserDriven(t.ledger, "B");
		await t.type(`autonomous ${a}\nlane model ${X} ${a}`);
		await t.type(`autonomous ${a}\nlane model ${X} for ${a}\nlane model ${Y} for ${b}`);
		expect(t.ledger.workload(a)!.mode).toBe("user-driven");
		expect(t.starts).toEqual([]);
	});
});

describe("T7: the wait is visible after a restart, and the newest input is the one", () => {
	test("the compact wake and the workload block name the input, its model and the recorder; a model-free workload shows none", async () => {
		const t = surface();
		const wl = openUserDriven(t.ledger, "Pending one");
		const free = openUserDriven(t.ledger, "Model free");
		await t.type(`lane model ${X} for ${wl}`);
		const input = t.lastInput();
		const wake = renderWake(t.ledger, { trigger: "restart" }).text;
		const line = wake.split("\n").find((l) => l.startsWith(`- ${wl}:`))!;
		expect(line).toContain(input);
		expect(line).toContain(X);
		expect(line).toContain(RECORDER);
		const freeLine = wake.split("\n").find((l) => l.startsWith(`- ${free}:`))!;
		expect(freeLine).not.toContain(RECORDER);
		expect(freeLine).not.toContain(X);
		const block = renderWake(t.ledger, { workloadId: wl }).text;
		expect(block).toContain(input);
		expect(block).toContain(RECORDER);
	});

	test("two model inputs at the same instant: the later row is the newest", async () => {
		const fixed = "2026-10-14T12:00:00.000Z";
		const { ledger, path } = tempLedger(() => fixed);
		const t = surface({ path, ledger });
		const wl = openUserDriven(ledger);
		ensureStandingWorkload(ledger);
		const first = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "jo", channel: "surface" });
		const second = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${Y} for ${wl}`, author: "jo", channel: "surface" });
		expect(await t.record(first, wl)).toContain(second);
		await t.record(second, wl);
		expect(recordedModel(ledger, wl)).toBe(Y);
	});
});

describe("T8: Jo's model line answering a question about its workload records the model and lifts the wait", () => {
	test("the answer path records the model and the reading; explicit launch and direct reservation then proceed", async () => {
		const c = clock();
		const { ledger, path } = tempLedger(c.now);
		const t = surface({ path, ledger });
		const wl = openUserDriven(ledger);
		const q = raiseOrchestratorQuestion(ledger, { body: `Which model should ${wl} run on?`, options: ["sol", "opus"], about: wl });
		c.plusHours(1);
		const input = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "jo", channel: "surface" });
		expect(reserve(ledger, wl, decideInteractive).ok).toBe(false);
		await t.tool(RECORDER, { questionId: q, inputId: input, reading: "run it on sol" });
		expect(ledger.question(q)!.state).toBe("answered");
		expect(recordedModel(ledger, wl)).toBe(X);
		expect(t.starts).toEqual([]);
		const launched = await t.tool("orchestrator_launch_lane", { workloadId: wl });
		expect(launched).not.toStartWith("Refused");
		expect(reserve(ledger, wl, decideInteractive)).toMatchObject({ ok: true });
	});

	test("a question with no subject cannot spend a model input", async () => {
		const c = clock();
		const { ledger, path } = tempLedger(c.now);
		const t = surface({ path, ledger });
		const wl = openUserDriven(ledger);
		const q = raiseOrchestratorQuestion(ledger, { body: "Anything else today?", options: ["yes", "no"], about: null });
		c.plusHours(1);
		const input = ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: `lane model ${X} for ${wl}`, author: "jo", channel: "surface" });
		expect(await t.tool(RECORDER, { questionId: q, inputId: input, reading: "yes" })).toContain("nothing was recorded");
		expect(ledger.question(q)!.state).toBe("open");
		expect(recordedModel(ledger, wl)).toBeNull();
		await t.type(`autonomous ${wl}`);
		expect(t.starts).toEqual([]);
	});
});
