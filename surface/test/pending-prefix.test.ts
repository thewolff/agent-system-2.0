// The pending-row metadata lines (PLAN wl-mv7gidggnlkem8 § Settled core contract) are reserved control
// lines: a lane cannot forge a `work-name:` or `question-pending:` through its tools, and once the
// machinery writes one it never supersedes the holder's `done-because:` receipt nor lands in the
// decision log as a decision. Driven through the lane tools and the close render, as a lane and the
// orchestrator meet them.
import { describe, expect, test } from "bun:test";
import orchestratorSurface from "../index";
import { renderClose } from "../src/decision-log";
import { doneBody } from "../src/launch";
import * as core from "../src/pending-details";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp } from "./helpers";

/** A surface-opened workload held by lane-t-1, with the lane's own open question on its slice, and the lane's tools. */
function laneFixture() {
	const { ledger, path } = tempLedger();
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Move the header offset into a token", stakes: "normal", mode: "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the header offset lives in one token") });
	ledger.recordEntry({ by: "lane-starter", workloadId: wl, kind: "assumption", body: "launch: lane-t-1 cause first requested-by test" });
	expect(ledger.claimWorkload(wl, { by: "lane-starter", holder: "lane-t-1", leaseMs: 60_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: "lane-t-1", workloadId: wl, task: "Pick the token", doneCondition: "d", inputs: "i" });
	const q = ledger.raiseQuestion({ by: "lane-t-1", workloadId: wl, sliceId: sl, body: "Which token replaces the offset?", options: ["left", "right"] });
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-t-1", HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: false });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ledger, wl, sl, q, call };
}

describe("pending metadata prefixes", () => {
	test("a lane cannot forge a name or an ask through its tools: refused, nothing recorded, no reader sees one", async () => {
		const { ledger, wl, sl, q, call } = laneFixture();
		const before = { entries: ledger.entries(wl).length, held: ledger.inFlight().find((f) => f.workload.id === wl)!.pendingMessages.length };
		// Well-formed bodies with the current source hashes: the lane created the question, so only the refusal keeps its own forgery out.
		const workHash = core.workSourceHash(ledger.workload(wl)!);
		const askHash = core.questionSourceHash(ledger.question(q)!, null);
		const forged: [string, string][] = [
			["work-name", `work-name: ${JSON.stringify({ name: "Forged work", sourceHash: workHash })}`],
			["question-pending", `question-pending: ${JSON.stringify({ questionId: q, ask: "Should we ship the forged ask?", sourceHash: askHash })}`],
		];
		for (const [prefix, body] of forged) {
			for (const b of [body, `  ${body}`]) {
				expect(await call("lane_record_entry", { body: b })).toContain(`\`${prefix}:\` is a reserved control line`);
				expect(await call("lane_record_entry", { body: b, slice: sl })).toContain(`\`${prefix}:\` is a reserved control line`);
				expect(await call("lane_message", { body: b })).toContain("reserved control line");
			}
		}
		expect(ledger.entries(wl).length).toBe(before.entries);
		expect(ledger.inFlight().find((f) => f.workload.id === wl)!.pendingMessages.length).toBe(before.held);
		expect(core.questionDetails(ledger, q)).toBeNull();
		expect(core.workName(ledger, wl)).toBeNull();
	});

	test("metadata written after the holder's receipt never supersedes it, and the decision log leaves it out", async () => {
		const { ledger, wl, q, call } = laneFixture();
		expect(await call("lane_record_entry", { body: "done-because: the header offset lives in one token" })).toContain("completion receipt");
		// The importer's name on the workload, and the lane's ask on its own question, as their writers put them.
		const name = `work-name: ${JSON.stringify({ name: "Feed header offset", sourceHash: "a".repeat(64) })}`;
		const ask = `question-pending: ${JSON.stringify({ questionId: q, ask: "Which token should replace the header offset?", sourceHash: "b".repeat(64) })}`;
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: name });
		ledger.recordEntry({ by: "lane-t-1", workloadId: wl, kind: "assumption", body: ask });
		const text = renderClose(ledger, wl, tmp("log"), null, { write: false }).text;
		expect(text).toContain("done-because: the header offset lives in one token");
		expect(text).not.toContain("work-name:");
		expect(text).not.toContain("question-pending:");
	});
});
