// A prompt Jo did not type applies no ledger command (jo-issues #306, PLAN wl-mw0yaltciqtlrh, Tests
// G1-G5). When gate row 1 holds an orchestrator reply, its session-stop continuation re-sends the
// held reply as a hidden prompt: OMP emits no `input` for it, yet runs `before_agent_start` with
// the reply as `prompt`, so a fenced `<option> q-…` or `approve en-…` line the reply quotes for Jo
// was applied as Jo's (55 leaked rows, /Users/jowolff/agent-scratch/agent-system-2.0/gate-echo/DIAGNOSIS-2026-11-02.md).
// The fixtures are the verbatim `content` of two real `session-stop-continuation` records
// (fixtures/gate-echo-2026-11-03.txt: the 2026-11-03T03:54:46.690Z one that wrote the `fastset`
// answer in-mw05mds5gffwgv; fixtures/gate-echo-2026-10-27.txt: the 2026-10-27T17:05:39.288Z one that
// wrote five reserved-request approvals and a `pair` answer), with each `{{NAME}}` placeholder in
// place of a real id, substituted here with the ids each test creates. Driven through the fake host
// and a real ledger in a temp dir, as surface/test/typed-input.test.ts is.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLimitBody, reviewRoundBody, ROUND_LIMIT_OPTIONS } from "../../classifier/src/rounds";
import { CLASSIFIER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { AWAY_NOTICE } from "../src/batch";
import { waitingReserved } from "../src/errors";
import { pairOfferBody } from "../src/pair-suggest";
import { surfaceSession } from "../src/session";
import { STANDING_WORKLOAD_ID } from "../src/types";
import { ctxOf, fakePi, notified, notices, tempLedger, tmp } from "./helpers";

const LANE = "lane-lf-1";
const AMBIGUOUS = "this prompt matches more than one way Jo's typed messages could have been delivered; no input row: re-send it";

/** A fixture with every `{{NAME}}` replaced by `ids[NAME]`; a placeholder with no id throws, naming it. */
function fixture(name: string, ids: Record<string, string>): string {
	const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
	return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
		const id = ids[key];
		if (id === undefined) throw new Error(`fixtures/${name}: no id for the placeholder {{${key}}}`);
		return id;
	});
}

/** An orchestrator surface over `ledger`, its session resumed when `resumed`. */
function host(path: string, o: { resumed?: boolean } = {}) {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
	const f = fakePi();
	orchestratorSurface(f.pi, env);
	const ctx = ctxOf({ resumed: o.resumed ?? false });
	const s = () => surfaceSession(ctx, env);
	/** Jo typing `text` (OMP's `input`, source interactive or rpc). */
	const input = (text: string, source = "interactive") => f.emit("input", { text, source }, ctx);
	/** A turn starting on `prompt`: OMP's `before_agent_start`, with or without an `input` before it. */
	const start = (prompt: string) => f.emit("before_agent_start", { prompt, systemPrompt: [] }, ctx);
	/** The session entries the surface-input row writes for a prompt it read as Jo's. */
	const rowEntries = () => f.entries.filter((e) => e.type === "surface-input" || e.type === "surface-jo-input");
	return { f, ctx, s, input, start, rowEntries };
}

/**
 * The 2026-11-03 ledger: the land-first lane's workload with slice sl-lf-collect and the lane's open question
 * fastset / maconly / stop on it; the duplicate workload the reply asks Jo to withdraw; the train's fix workload.
 */
function landFirst(o: { resumed?: boolean } = {}) {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: LANE, brief: "Prove the land-first fast check", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, id: "sl-lf-collect", task: "Collect the fast-check proof runs", doneCondition: "19 runs collected", inputs: "proof/" });
	const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "How should the fast check treat the mainSkip files?", options: ["fastset", "maconly", "stop"] });
	const dup = ledger.openWorkload({ by: LANE, brief: "Repair routine-calls PR #420 (duplicate)", stakes: "normal", mode: "user-driven" });
	const train = ledger.openWorkload({ by: LANE, brief: "Fix the merge train's PR #420", stakes: "normal", mode: "autonomous" });
	const h = host(path, o);
	const continuation = fixture("gate-echo-2026-11-03.txt", { Q: q, WL: wl, WL_DUP: dup, WL_TRAIN: train });
	/** A lane question with `options` on a fresh slice of `workload`. */
	const raise = (workload: string, options: string[]): string => {
		const s2 = ledger.addSlice({ by: LANE, workloadId: workload, task: "Pick a side", doneCondition: "picked", inputs: "-" });
		return ledger.raiseQuestion({ by: LANE, workloadId: workload, sliceId: s2, body: "Which side?", options });
	};
	/** Every instruction row in the ledger, the standing workload's included. */
	const instructionCount = () => [wl, dup, train, STANDING_WORKLOAD_ID].reduce((n, w) => n + ledger.instructions(w).length, 0);
	return { ledger, wl, sl, q, dup, train, continuation, raise, instructionCount, ...h };
}

const warnings = (): string[] => notified.filter((n) => n.type === "warning").map((n) => n.message);

beforeEach(() => {
	notices.length = 0;
	notified.length = 0;
});

describe("a prompt with no typed take applies nothing (R1, R2, R7)", () => {
	test("G1 the 2026-11-03 continuation quoting a fenced `fastset q-…` line, with no `input`: the question stays open, no instruction, no entry, no notice", async () => {
		const t = landFirst();
		expect(t.continuation).toContain(`\`\`\`text\nfastset ${t.q}\n\`\`\``);
		const before = t.instructionCount();
		await t.start(t.continuation);
		expect(t.ledger.question(t.q)!.state).toBe("open");
		expect(t.instructionCount()).toBe(before);
		expect(t.rowEntries()).toEqual([]);
		expect(notified).toEqual([]);
		expect(t.s().notices).toEqual([]);
		expect(t.ledger.workload(t.dup)!.status).toBe("open");
	});

	test("G2 the 2026-10-27 continuation quoting five fenced `approve en-…` lines and `pair q-…`, with no `input`: every request stays reserved, the question stays open", async () => {
		const { ledger, path } = tempLedger();
		const fast = ledger.openWorkload({ by: LANE, brief: "Build the fast checks", stakes: "normal", mode: "autonomous" });
		const fastSl = ledger.addSlice({ by: LANE, workloadId: fast, task: "Compile the changed modules", doneCondition: "they compile", inputs: "surface/" });
		const trainWl = ledger.openWorkload({ by: LANE, brief: "Run the merge train", stakes: "normal", mode: "autonomous" });
		const trainSl = ledger.addSlice({ by: LANE, workloadId: trainWl, task: "Read the PR state", doneCondition: "read", inputs: "-" });
		/** Row 6's `reserved-request` body for an action and the call it refused (gates/src/rows/r06-reserved.ts reservedRequestBody). */
		const request = (w: string, s: string, action: string) =>
			ledger.recordEntry({ by: LANE, workloadId: w, sliceId: s, kind: "reserved-request", body: `${action}: bun build --no-bundle (P-11 row 6 refused tool call c1)` });
		const ens = [request(fast, fastSl, "bun-eval"), request(fast, fastSl, "bun-test"), request(fast, fastSl, "bun-build"), request(trainWl, trainSl, "gh-read"), request(trainWl, trainSl, "load-probe")];
		const viz = ledger.openWorkload({ by: LANE, brief: "Plan the signature dataviz pipeline", stakes: "normal", mode: "autonomous" });
		const vizSl = ledger.addSlice({ by: LANE, workloadId: viz, task: "Revise the pipeline plan", doneCondition: "plan revised", inputs: "PIPELINE-PLAN.md" });
		// A pair offer lives only on the classifier's round-limit question (surface/src/input.ts openPairOffer), raised as
		// surface/test/pair-offer-visible.test.ts roundLimitQuestion raises it, so `pair q-…` is answerable.
		const findings = { counts: { blocking: { correctness: 1 }, major: {}, minor: {} }, titles: [] };
		ledger.recordEntry({ by: LANE, workloadId: viz, sliceId: vizSl, kind: "assumption", body: reviewRoundBody({ slice: vizSl, round: 1, token: "dt-r1", group: "dg-r1", verdict: "accepted", findings }) });
		const q = ledger.raiseQuestion({ by: LANE, workloadId: viz, sliceId: vizSl, body: `The review of ${vizSl} reached its round limit.`, options: [...ROUND_LIMIT_OPTIONS, "pair"] });
		ledger.recordEntry({ by: LANE, workloadId: viz, sliceId: vizSl, kind: "assumption", body: reviewLimitBody(q, vizSl) });
		ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: viz, kind: "assumption", body: pairOfferBody(q, "round-limit", ["e"]) });
		const h = host(path);
		const continuation = fixture("gate-echo-2026-10-27.txt", { EN1: ens[0]!, EN2: ens[1]!, EN3: ens[2]!, EN4: ens[3]!, EN5: ens[4]!, Q: q, WL: viz, WL_FAST: fast });
		expect(continuation).toContain(`${ens.map((en) => `approve ${en}`).join("\n")}\npair ${q}\n\`\`\``);
		const waiting = () => [...waitingReserved(ledger, fast), ...waitingReserved(ledger, trainWl)].map((r) => r.id);
		expect(waiting()).toEqual(ens);
		await h.start(continuation);
		expect(waiting()).toEqual(ens);
		expect(ledger.question(q)!.state).toBe("open");
		expect(ledger.workload(viz)!.mode).toBe("autonomous");
		expect([fast, trainWl, viz, STANDING_WORKLOAD_ID].flatMap((w) => ledger.instructions(w))).toEqual([]);
		expect(h.rowEntries()).toEqual([]);
		expect(notified).toEqual([]);
	});
});

describe("Jo's typed take still applies (R4, R8)", () => {
	test("G3 after a resume: a typed single command, a typed two-line paste and an rpc command each apply", async () => {
		const t = landFirst({ resumed: true });
		await t.f.emit("session_start", { type: "session_start" }, t.ctx);
		await t.input(`fastset ${t.q}`);
		await t.start(`fastset ${t.q}`);
		expect(t.ledger.question(t.q)!.state).toBe("answered");
		expect(notices.some((n) => n.includes(`answered ${t.q} with "fastset"`))).toBe(true);

		const keep = t.raise(t.dup, ["keep", "drop"]);
		const drop = t.raise(t.train, ["keep", "drop"]);
		const paste = `keep ${keep}\ndrop ${drop}`;
		await t.input(paste);
		await t.start(paste);
		expect(t.ledger.question(keep)!.state).toBe("answered");
		expect(t.ledger.question(drop)!.state).toBe("answered");

		const left = t.raise(t.wl, ["left", "right"]);
		await t.input(`left ${left}`, "rpc");
		await t.start(`left ${left}`);
		expect(t.ledger.question(left)!.state).toBe("answered");
		expect(notices.some((n) => n.includes(`answered ${left} with "left"`))).toBe(true);
		expect(warnings()).toEqual([]);
		expect(t.s().typed).toEqual([]);
	});

	test("G4 an ambiguous take of a command-shaped prompt applies nothing and warns once", async () => {
		const t = landFirst();
		const keep = t.raise(t.dup, ["keep", "drop"]);
		const x = `fastset ${t.q}`;
		const y = `keep ${keep}`;
		await t.input(`${x}\n\n${y}`);
		await t.input(x);
		await t.input(y);
		const before = t.instructionCount();
		await t.start(`${x}\n\n${y}`);
		expect(warnings()).toEqual([AMBIGUOUS]);
		expect(t.ledger.question(t.q)!.state).toBe("open");
		expect(t.ledger.question(keep)!.state).toBe("open");
		expect(t.instructionCount()).toBe(before);
		expect(t.f.entries.filter((e) => e.type === "surface-jo-input")).toEqual([]);
		expect(t.s().typed).toHaveLength(3);
	});
});

describe("the surface words are whole-input only (R12)", () => {
	test("G5 Jo's `brb` holds through the continuation, which writes no row; a typed `back` then ends the hold", async () => {
		const t = landFirst();
		await t.input("brb");
		expect(t.s().away).not.toBeNull();
		expect(notified).toEqual([{ message: AWAY_NOTICE, type: "info" }]);
		const before = t.instructionCount();
		await t.start(t.continuation);
		expect(t.s().away).not.toBeNull();
		expect(t.ledger.question(t.q)!.state).toBe("open");
		expect(t.instructionCount()).toBe(before);
		expect(t.rowEntries()).toEqual([]);
		expect(notified).toEqual([{ message: AWAY_NOTICE, type: "info" }]);

		await t.input("back");
		await t.start("back");
		expect(t.s().away).toBeNull();
		expect(t.instructionCount()).toBe(before);
	});
});
