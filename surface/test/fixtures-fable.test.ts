// The M5 review-fable-1 correctness fixtures (agent-scratch/agent-system-2.0/migration/M5/review-fable-1/fixtures.ts),
// ported as tests with the state each § B3 line must reach after fix round 1. Fixture names are the
// review's (F1a … F5b); each test builds the same ledger rows through the ledger module and reads
// them back the way the surface does. The ones that flipped in the fix round: F1b (a claim writer
// exists, so a dead lane is line 4, not silence then line 2), F1d (a takeover keeps the death),
// F2c/F2f (orchestrator-bound rows never mean "no live lane"), F2d (an open workload with no
// slices and no lane is held), F5a/F5b (an unbound reserved refusal lands where the surface reads).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import reservedRow from "../../gates/extensions/r06-reserved";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { errorLines } from "../src/errors";
import { renderWake } from "../src/render";
import { ARTIFACT_FAILED_PREFIX, LEASE_MS, STANDING_WORKLOAD_ID } from "../src/types";
import { clock, ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const wlWithSlice = (ledger: Ledger) => {
	const wl = ledger.openWorkload({ by: "lane-a", brief: "Fix the feed header offset", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "Move the header offset into a token", doneCondition: "bun test passes", inputs: "src/header.css" });
	return { wl, sl };
};
const kinds = (ledger: Ledger, now: string) => errorLines(ledger, undefined, { now }).map((l) => l.kind);
const text = (ledger: Ledger, now: string) => errorLines(ledger, undefined, { now }).map((l) => l.line);
type Started = { messages: { content: string }[] };

describe("F1: lane dead, slice open (§ B3 item 4)", () => {
	test("F1a: holder with a lapsed lease is line 4", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = wlWithSlice(ledger);
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		c.plusHours(1.5);
		expect(text(ledger, c.now())).toEqual([expect.stringMatching(/^lane lane-a on wl-.* died: lease lapsed 2026-10-01T11:00:00\.000Z, 1 open slice\(s\)$/)]);
	});

	test("F1b: a lane session that started is a holder (the lane row claims), so its death is line 4 at 1.5h and still line 4 (not line 2) at 4.1h", async () => {
		const path = join(tmp("ledger"), "ledger.db");
		const c = clock();
		const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false, clock: c.now });
		const { wl } = wlWithSlice(ledger);
		const f = fakePi();
		orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-a", HOME: "/nonexistent-home" });
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		const w = ledger.workload(wl)!;
		expect(w.holder).toBe("lane-a");
		// the lane's own connection stamped the lease from the real clock; the fixture reads at that clock + 1.5h
		const leaseAt = Date.parse(w.holder_lease_until!) - LEASE_MS;
		const at = (h: number) => new Date(leaseAt + h * 3_600_000).toISOString();
		expect(kinds(ledger, at(0.1))).toEqual([]);
		expect(text(ledger, at(1.5))).toEqual([expect.stringMatching(/^lane lane-a on wl-.* died: lease lapsed .*, 1 open slice\(s\)$/)]);
		expect(kinds(ledger, at(4.1))).toEqual(["lane-died"]);
		ledger.close();
	});

	test("F1c: a dead lane whose only slice is paused on a question is line 4 and the question", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["a", "b"] });
		c.plusHours(2);
		expect(kinds(ledger, c.now())).toEqual(["lane-died", "question"]);
	});

	test("F1d: a lease that lapsed and was reclaimed by a second lane before the wake is still surfaced, once, naming the new holder", async () => {
		const path = join(tmp("ledger"), "ledger.db");
		const c = clock("2026-09-01T10:00:00.000Z"); // past: the reclaim compares the lease to sqlite's real now
		const ledger = Ledger.open(path, { create: true, backup: false, backupOnOpen: false, clock: c.now });
		const { wl } = wlWithSlice(ledger);
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		c.plusHours(2);
		const f = fakePi();
		orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: "lane-b", HOME: "/nonexistent-home" });
		await f.emit("session_start", { type: "session_start" }, ctxOf());
		expect(ledger.workload(wl)!.holder).toBe("lane-b");
		c.plusHours(0.1);
		const lines = errorLines(ledger, undefined, { now: c.now() });
		expect(lines.map((l) => l.kind)).toEqual(["lane-died"]);
		expect(lines[0]!.line).toContain("lane lane-a on");
		expect(lines[0]!.line).toContain("lane-b holds it now");
		// surfaced once: the wake render consumes it
		renderWake(ledger, { trigger: "session-start", now: c.now() });
		ledger.advanceMessage(lines[0]!.messageIds![0]!, "delivered", { by: "surface" });
		expect(kinds(ledger, c.now())).toEqual([]);
		ledger.close();
	});
});

describe("F2: held > 4h (§ B3 item 2, § A3)", () => {
	test("F2a: a message to a lane held 4.1h is line 2 with the age", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		c.plusHours(4.1);
		expect(text(ledger, c.now())).toEqual([expect.stringMatching(/^held 4\.1h on wl-.*: message msg-.* \(jo → lane-a\) has had no live lane since /)]);
	});

	test("F2b: a delivered (not held) message 5h old with no holder: the workload's second form fires, not the message form", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		const m = ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		ledger.advanceMessage(m, "delivered", { by: "lane-a" });
		c.plusHours(5);
		expect(text(ledger, c.now())).toEqual([expect.stringMatching(/^held 5h on wl-.*: 1 open slice\(s\), no lane, no activity since /)]);
	});

	test("F2f: artifact-failed rows left after their slice is done, with a live lane holding the next slice: nothing", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		for (const n of [1, 2]) ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} push refused ${n}` });
		ledger.completeSlice(sl, { by: "lane-a", artifact: "push accepted" });
		ledger.addSlice({ by: "lane-a", workloadId: wl, task: "next slice", doneCondition: "d", inputs: "i" });
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 24 * 3_600_000 });
		c.plusHours(5);
		expect(kinds(ledger, c.now())).toEqual([]);
	});

	test("F2c: two artifact-failed rows to the orchestrator held 4.1h are line 3, never line 2 ('no live lane' is not about a row addressed to the orchestrator)", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		for (const n of [1, 2]) ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: sl, sender: "lane-a", recipient: "orchestrator", body: `${ARTIFACT_FAILED_PREFIX} push refused ${n}` });
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 24 * 3_600_000 });
		c.plusHours(4.1);
		expect(kinds(ledger, c.now())).toEqual(["artifact"]);
	});

	test("F2d: a workload open with zero slices, no holder and no activity for 5h is line 2", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		ledger.openWorkload({ by: "orchestrator", brief: "Migrate the feeds table", stakes: "normal", mode: "autonomous" });
		c.plusHours(5);
		expect(text(ledger, c.now())).toEqual([expect.stringMatching(/^held 5h on wl-.*: 0 open slice\(s\), no lane, no activity since /)]);
	});

	test("F2e: a message still held on a closed workload is not a line (in flight = open workloads; the close is the receipt)", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		ledger.enqueue({ by: "surface", workloadId: wl, sliceId: sl, sender: "jo", recipient: "lane-a", body: "use the token" });
		ledger.completeSlice(sl, { by: "lane-a", artifact: "bun test exit 0" });
		ledger.closeWorkload(wl, { by: "lane-a" });
		c.plusHours(5);
		expect(kinds(ledger, c.now())).toEqual([]);
	});
});

describe("F3: question answered, slice not resumed", () => {
	test("F3a: an answer resumes the slice; paused-without-a-question cannot be forced through the file; an answer nobody picked up in 4h is line 2", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, sl } = wlWithSlice(ledger);
		const q = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["a", "b"] });
		expect(ledger.slice(sl)!.state).toBe("paused");
		ledger.answerQuestion(q, { by: "surface", answer: "a", author: "jo", channel: "surface" });
		expect(ledger.slice(sl)!.state).toBe("open");
		expect(() => ledger.db.query("UPDATE slices SET state = 'paused', changed_by = 'x', changed_at = ?, rev = rev + 1 WHERE id = ?").run(c.now(), sl)).toThrow();
		c.plusHours(1);
		expect(kinds(ledger, c.now())).toEqual([]);
		c.plusHours(3.1);
		expect(kinds(ledger, c.now())).toEqual(["held"]);
	});

	test("F3b: two questions on one slice, one answered: the open one is the line", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = wlWithSlice(ledger);
		const q1 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which token?", options: ["a", "b"] });
		const q2 = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: sl, body: "Which file?", options: ["x", "y"] });
		ledger.answerQuestion(q1, { by: "surface", answer: "a", author: "jo", channel: "surface" });
		const lines = errorLines(ledger);
		expect(lines.map((l) => [l.kind, l.rowId])).toEqual([["question", q2]]);
	});
});

describe("F5: reserved refusal with no workload bound (§ B3 item 1)", () => {
	for (const role of ["lane", "orchestrator"]) {
		test(`F5${role === "lane" ? "a" : "b"}: role=${role}, no workload id: the refusal lands on the standing workload and the wake renders it`, async () => {
			const path = join(tmp("ledger"), "ledger.db");
			Ledger.open(path, { create: true, backup: false, backupOnOpen: false }).close();
			const f = fakePi();
			reservedRow(f.pi, { AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_ROLE: role, HOME: "/nonexistent-home" });
			const r = (await f.emit("tool_call", { toolName: "bash", toolCallId: "call-1", input: { command: "git push --force origin main" } }, ctxOf({ hasUI: true }))) as { block?: boolean };
			expect(r?.block).toBe(true);
			const ledger = Ledger.open(path, { create: false, backup: false, backupOnOpen: false });
			const wake = renderWake(ledger, { trigger: "session-start" });
			const reserved = wake.lines.filter((l) => l.kind === "reserved");
			expect(reserved).toHaveLength(1);
			expect(reserved[0]!.workloadId).toBe(STANDING_WORKLOAD_ID);
			// A force-push is a history rewrite, so the line carries the NOW (irreversible) tag (PLAN wl-mvg1vs0rhnu3gg § 1.3).
			expect(reserved[0]!.line).toMatch(/^NOW \(irreversible\): reserved action waiting on you \(orchestrator\): .*git push --force origin main.* — `approve en-.*` or `deny en-.*`$/);
			expect(wake.text).toContain("## needs you");
			expect(wake.text).toContain(reserved[0]!.line);
			ledger.close();
		});
	}
});

describe("F4: wake after restart / compaction", () => {
	test("F4a/F4b/F4c: restart re-owes the read; compaction renders what another connection wrote since; identity is refused while the read is owed and the render says so", async () => {
		const path = join(tmp("ledger"), "ledger.db");
		Ledger.open(path, { create: true, backup: false, backupOnOpen: false }).close();
		const voice = join(tmp("voice"), "VOICE.md");
		writeFileSync(voice, "VOICE DOC BODY");
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
		const f1 = fakePi();
		orchestratorSurface(f1.pi, env);
		const ctx1 = ctxOf();
		await f1.emit("session_start", { type: "session_start" }, ctx1);
		const s1 = (await f1.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx1)) as Started;
		// F4c: the render no longer says "before anything else"; the identity tool is refused while the read is owed
		expect(s1.messages[0]!.content).toContain("right after the wake read below");
		expect(s1.messages[0]!.content).not.toContain("before anything else");
		const identityWhileOwed = (await f1.emit("tool_call", { toolName: "orchestrator_identity", input: { name: "Ori", pronouns: "they/them" } }, ctx1)) as { block?: boolean };
		expect(identityWhileOwed?.block).toBe(true);
		await f1.tool("orchestrator_wake_read").execute("1", { body: "session 1: nothing open" }, undefined, undefined, ctx1);
		// F4a: a new process resuming the session re-owes the read
		const f2 = fakePi();
		orchestratorSurface(f2.pi, env);
		const ctx2 = ctxOf({ resumed: true });
		await f2.emit("session_start", { type: "session_start" }, ctx2);
		const s2 = (await f2.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx2)) as Started;
		expect(s2.messages[0]!.content).toContain("(wake: restart)");
		expect(((await f2.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx2)) as { block?: boolean })?.block).toBe(true);
		await f2.tool("orchestrator_wake_read").execute("2", { body: "session 2: nothing open" }, undefined, undefined, ctx2);
		// F4b: a lane writes on its own connection between the wake and the compaction
		const lane = Ledger.open(path, { create: false, backup: false, backupOnOpen: false });
		const wl = lane.openWorkload({ by: "lane-b", brief: "Written by a lane after session 2 woke", stakes: "normal", mode: "autonomous" });
		const sl = lane.addSlice({ by: "lane-b", workloadId: wl, task: "lane-b task", doneCondition: "d", inputs: "i" });
		const q = lane.raiseQuestion({ by: "lane-b", workloadId: wl, sliceId: sl, body: "Lane-b question raised after the wake", options: ["p", "q"] });
		lane.close();
		await f2.emit("session_compact", { type: "session_compact" }, ctx2);
		const s3 = (await f2.emit("before_agent_start", { prompt: "go on", systemPrompt: [] }, ctx2)) as Started;
		const post = s3.messages[0]!.content;
		expect(post).toContain("(wake: compaction)");
		expect(post).toContain(q);
		expect(post).toContain("Lane-b question raised after the wake");
		expect(((await f2.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx2)) as { block?: boolean })?.block).toBe(true);
	});
});
