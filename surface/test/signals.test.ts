// The signal rows the lane writes and the surface reads (surface/src/signals.ts): a lapsed lease
// recorded once per lane (any lane-died: row naming it counts), prompt waits resolved by their own row or by the lane's
// death, the newest artifact-command declaration per live slice (and per open, paused or done slice
// for the artifact-tree recorder), failures counted since the last pass, and the artifact-tree
// records of passing runs.
import { describe, expect, test } from "bun:test";
import {
	artifactCommandBody, artifactCommands, artifactFailedBody, artifactFailures, artifactPassedBody, artifactTreeBody, artifactTrees, laneDeaths, laneDiedShutdownBody, laneDiedSignalBody,
	openPromptWaits, promptResolvedBody, promptWaitBody, recordableArtifactCommands, recordLapsedLease, recordLapsedLeases, unrecordedLapse,
} from "../src/signals";
import { ORCHESTRATOR_RECIPIENT } from "../src/types";
import { clock, tempLedger, workloadWithSlice } from "./helpers";

describe("lapsed leases", () => {
	test("recorded once per lane, only when lapsed; the same lane's renewed lease that lapses again adds no second death, another lane's lapse does (PLAN wl-mvfqvd5hy8zv28 § 1.2)", () => {
		const c = clock("2026-09-01T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(false);
		expect(recordLapsedLease(ledger, ledger.workload(wl)!, "surface", c.now())).toBeNull();
		c.plusHours(2);
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(true);
		const id = recordLapsedLease(ledger, ledger.workload(wl)!, "surface", c.now());
		expect(id).toMatch(/^msg-/);
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(false);
		expect(recordLapsedLease(ledger, ledger.workload(wl)!, "surface", c.now())).toBeNull();
		expect(recordLapsedLeases(ledger, "surface", c.now())).toEqual([]);
		expect(laneDeaths(ledger, wl)).toEqual([expect.objectContaining({ id, holder: "lane-a", state: "held", body: "lane-died: lane-a: lease lapsed 2026-09-01T11:00:00.000Z" })]);
		// the same lane renews (a reclaim after a lapse) and lapses again: still its one death, and no unrecorded lapse
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		c.plusHours(2);
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(false);
		expect(recordLapsedLeases(ledger, "surface", c.now())).toEqual([]);
		expect(laneDeaths(ledger, wl).map((d) => d.id)).toEqual([id]);
		// another lane takes over and lapses: its own death
		ledger.claimWorkload(wl, { by: "lane-c", holder: "lane-c", leaseMs: 3_600_000 });
		c.plusHours(2);
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(true);
		expect(recordLapsedLeases(ledger, "surface", c.now())).toHaveLength(1);
		expect(laneDeaths(ledger, wl).map((d) => d.holder)).toEqual(["lane-a", "lane-c"]);
		// a closed workload records nothing (the close waits for the lease to lapse: closeWorkload refuses a live holder, Codex review S2)
		const other = workloadWithSlice(ledger);
		ledger.claimWorkload(other.wl, { by: "lane-b", holder: "lane-b", leaseMs: 1000 });
		ledger.completeSlice(other.sl, { by: "lane-b", artifact: "done" });
		c.plusHours(1);
		ledger.closeWorkload(other.wl, { by: "lane-b" });
		expect(recordLapsedLease(ledger, ledger.workload(other.wl)!, "surface", c.now())).toBeNull();
	});

	test("a lane whose runner recorded its restart death (stopped by signal) and then lapsed gets no lease-lapse death and no unrecorded lapse (review r6 F2, r7 F1)", () => {
		const c = clock("2026-09-01T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		ledger.claimWorkload(wl, { by: "lane-a", holder: "lane-a", leaseMs: 3_600_000 });
		const death = ledger.enqueue({ by: "lane-runner", workloadId: wl, sender: "lane-runner", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedSignalBody("lane-a", "SIGTERM", 1) });
		c.plusHours(2);
		expect(unrecordedLapse(ledger, ledger.workload(wl)!, c.now())).toBe(false);
		expect(recordLapsedLease(ledger, ledger.workload(wl)!, "surface", c.now())).toBeNull();
		expect(laneDeaths(ledger, wl)).toEqual([expect.objectContaining({ id: death, holder: "lane-a", body: "lane-died: lane-a: stopped by signal SIGTERM (restart), 1 open slice(s)" })]);
	});
});

describe("prompt waits", () => {
	test("open until the matching resolved row; a later lane death of the sender ends every wait of that lane", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const row = (sender: string, body: string) => ledger.enqueue({ by: sender, workloadId: wl, sliceId: sl, sender, recipient: ORCHESTRATOR_RECIPIENT, body });
		row("lane-a", promptWaitBody("bash", "c1", "s1", "needs approval"));
		row("lane-a", promptWaitBody("ask", "c2", "", "ask: which?"));
		row("lane-b", promptWaitBody("bash", "c3", "s2", "needs approval too"));
		expect(openPromptWaits(ledger, wl).map((w) => [w.lane, w.toolName, w.toolCallId, w.reason])).toEqual([
			["lane-a", "bash", "c1", "needs approval"],
			["lane-a", "ask", "c2", "ask: which?"],
			["lane-b", "bash", "c3", "needs approval too"],
		]);
		row("lane-a", promptResolvedBody("bash", "c1", "s1", "approved"));
		row("lane-a", promptResolvedBody("bash", "c2", "s1", "wrong key: not a match"));
		expect(openPromptWaits(ledger, wl).map((w) => w.toolCallId)).toEqual(["c2", "c3"]);
		ledger.enqueue({ by: "lane-a", workloadId: wl, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body: laneDiedShutdownBody("lane-a", ledger.now(), 1) });
		expect(openPromptWaits(ledger, wl).map((w) => w.toolCallId)).toEqual(["c3"]);
		// a wait raised after the death is open again
		row("lane-a", promptWaitBody("bash", "c4", "s3", "again"));
		expect(openPromptWaits(ledger, wl).map((w) => w.toolCallId)).toEqual(["c3", "c4"]);
	});
});

describe("artifact declarations and outcomes", () => {
	test("the newest declaration per live slice wins; a done slice's declaration is dropped", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: artifactCommandBody("bun test a") });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: "an ordinary assumption" });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "assumption", body: artifactCommandBody("  bun test a --bail ") });
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl2, kind: "assumption", body: artifactCommandBody("bun test b") });
		expect(artifactCommands(ledger, wl)).toEqual(new Map([[sl, "bun test a --bail"], [sl2, "bun test b"]]));
		ledger.completeSlice(sl2, { by: "lane-a", artifact: "passed" });
		expect(artifactCommands(ledger, wl)).toEqual(new Map([[sl, "bun test a --bail"]]));
	});

	test("the recordable declarations: the newest per open, paused or done slice; a cancelled slice's is dropped; another workload's never shows", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const add = (task: string) => ledger.addSlice({ by: "lane-a", workloadId: wl, task, doneCondition: "d", inputs: "i" });
		const [paused, done, cancelled] = [add("paused"), add("done"), add("cancelled")];
		const declared = (slice: string, command: string, workloadId = wl) => ledger.recordEntry({ by: "lane-a", workloadId, sliceId: slice, kind: "assumption", body: artifactCommandBody(command) });
		declared(sl, "bun test a");
		declared(paused, "bun test p");
		declared(done, "bun test d");
		declared(done, " bun test d --bail ");
		declared(cancelled, "bun test c");
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: paused, body: "which?", options: ["x", "y"] });
		ledger.completeSlice(done, { by: "lane-a", artifact: "passed" });
		ledger.cancelSlice(cancelled, { by: "lane-a" });
		const other = workloadWithSlice(ledger);
		declared(other.sl, "bun test a", other.wl);
		ledger.completeSlice(other.sl, { by: "lane-a", artifact: "passed" });
		expect(ledger.slice(paused)!.state).toBe("paused");
		expect(recordableArtifactCommands(ledger, wl)).toEqual(new Map([[sl, "bun test a"], [paused, "bun test p"], [done, "bun test d --bail"]]));
		// the outcome-message set is unchanged: live slices only
		expect(artifactCommands(ledger, wl)).toEqual(new Map([[sl, "bun test a"], [paused, "bun test p"]]));
	});

	test("failures count since the last pass, per slice, with the held ids the surface consumes", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		const row = (slice: string, body: string) => ledger.enqueue({ by: "lane-a", workloadId: wl, sliceId: slice, sender: "lane-a", recipient: ORCHESTRATOR_RECIPIENT, body });
		const a1 = row(sl, artifactFailedBody("exit 1"));
		const a2 = row(sl, artifactFailedBody("exit 1"));
		row(sl2, artifactFailedBody("exit 2"));
		expect(artifactFailures(ledger, wl)).toEqual(new Map([[sl, { n: 2, heldIds: [a1, a2] }], [sl2, { n: 1, heldIds: [expect.any(String)] }]]));
		ledger.advanceMessage(a1, "delivered", { by: "surface" });
		expect(artifactFailures(ledger, wl).get(sl)).toEqual({ n: 2, heldIds: [a2] });
		row(sl, artifactPassedBody("exit 0"));
		expect(artifactFailures(ledger, wl).get(sl)).toEqual({ n: 0, heldIds: [] });
		const a3 = row(sl, artifactFailedBody("exit 1 again"));
		expect(artifactFailures(ledger, wl).get(sl)).toEqual({ n: 1, heldIds: [a3] });
	});

	test("artifact-tree records come back oldest first, on done slices too; a malformed one is skipped", () => {
		const { ledger } = tempLedger();
		const { wl, sl } = workloadWithSlice(ledger);
		const sl2 = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "second", doneCondition: "d", inputs: "b.ts" });
		const entry = (slice: string | null, body: string) => ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: slice, kind: "assumption", body });
		const a = { repo: "/r/with space", tree: "a".repeat(40), command: "bun test a" };
		const b = { repo: "/r/with space", tree: "b".repeat(40), command: "bun test b" };
		entry(sl, artifactTreeBody(a));
		entry(sl2, "artifact-tree: {not json");
		entry(sl2, 'artifact-tree: {"repo":"/r","tree":"c"}');
		entry(sl2, "artifact-tree: [1,2]");
		entry(null, artifactTreeBody(b));
		entry(sl2, artifactTreeBody(b));
		ledger.recordEntry({ by: "lane-a", workloadId: wl, sliceId: sl, kind: "reserved-request", body: artifactTreeBody(b) });
		ledger.completeSlice(sl, { by: "lane-a", artifact: "passed" });
		expect(artifactTrees(ledger, wl)).toEqual([{ sliceId: sl, ...a }, { sliceId: sl2, ...b }]);
		expect(artifactTrees(ledger, workloadWithSlice(ledger).wl)).toEqual([]);
	});
});
