// The lane launcher's ledger half (DESIGN-lane-launcher.md § 5; decisions 5, 8, 14): the
// holder-checked release, `reserveLane` under an injected policy, `parkLane` and `handoffWorkload`.
// The policy here is a stand-in for the surface's predicate (that one is tested against
// `reserveLane` in surface/test/launch.test.ts); these tests are about what the transaction does.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_RUNNER_BY, LANE_STARTER_BY, Ledger, type ReserveRows, type ReserveVerdict } from "../src/index";

const REPO = join(import.meta.dir, "..", "..");
const scratch = (label: string) => mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), `lane-${label}-`));
const fresh = (label: string) => {
	const path = join(scratch(label), "ledger.db");
	return { path, ledger: Ledger.open(path, { create: true }) };
};

/** A stand-in for the launch predicate: open, autonomous, unheld or lapsed, under the cap, and one attempt at most. */
function decide(rows: ReserveRows): ReserveVerdict {
	const w = rows.workload;
	if (w.status !== "open") return { launch: false, reason: "closed" };
	if (w.mode !== "autonomous") return { launch: false, reason: "user-driven" };
	if (w.holder !== null && (w.holder_lease_until === null || w.holder_lease_until >= rows.now)) return { launch: false, reason: "held" };
	if (rows.liveLanes >= rows.cap) return { launch: false, reason: "cap" };
	const attempts = rows.entries.filter((e) => e.kind === "assumption" && e.body.startsWith("launch: "));
	if (attempts.length === 0) return { launch: true, cause: "first" };
	return { launch: false, reason: "died-not-relaunched" };
}
/** The workload the caller names as where Jo's typed inputs live: the surface passes its standing workload; the ledger hard-codes none. */
const RECEIPTS = "wl-receipts";
const reserve = (l: Ledger, wl: string, cap = 3) => l.reserveLane(wl, { by: LANE_STARTER_BY, cap, leaseMs: 180_000, requestedBy: "test", receiptWorkload: RECEIPTS, decide });
const launches = (l: Ledger, wl: string) => l.entries(wl, "assumption").filter((e) => e.body.startsWith("launch: "));

describe("holder-checked release (decision 5)", () => {
	test("the wrong holder is refused and told who holds; the right one releases; nobody's release names nobody", () => {
		const { ledger: l } = fresh("release");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch" });
		expect(l.claimWorkload(w, { by: "lane-b-1", holder: "lane-b-1", leaseMs: 60_000 })).toEqual({ won: true });
		expect(l.releaseWorkload(w, { by: "lane-b-2", holder: "lane-b-2" })).toEqual({ released: false, holder: "lane-b-1" });
		expect(l.workload(w)!.holder).toBe("lane-b-1");
		expect(l.releaseWorkload(w, { by: "lane-b-1", holder: "lane-b-1" })).toEqual({ released: true });
		expect(l.workload(w)).toMatchObject({ holder: null, holder_lease_until: null, changed_by: "lane-b-1" });
		expect(l.releaseWorkload(w, { by: "lane-b-1", holder: "lane-b-1" })).toEqual({ released: false, holder: null });
		l.close();
	});
});

describe("reserveLane (decision 8)", () => {
	test("a launch verdict mints lane-<suffix>-1, pre-claims stamped lane-starter with the lease, and writes one launch: entry naming the cause", () => {
		const { ledger: l } = fresh("reserve");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch", id: "wl-abc123" });
		const r = reserve(l, w);
		expect(r).toEqual({ ok: true, laneId: "lane-abc123-1", cause: "first" });
		const row = l.workload(w)!;
		expect(row.holder).toBe("lane-abc123-1");
		expect(row.changed_by).toBe(LANE_STARTER_BY);
		expect(Date.parse(row.holder_lease_until!) - Date.parse(row.changed_at)).toBeGreaterThanOrEqual(179_000);
		const ls = launches(l, w);
		expect(ls).toHaveLength(1);
		expect(ls[0]).toMatchObject({ created_by: LANE_STARTER_BY, body: "launch: lane-abc123-1 cause first requested-by test" });
		l.close();
	});

	test("a refusal returns the policy's reason and writes nothing: no entry, no claim, rev unchanged", () => {
		const { ledger: l } = fresh("refuse");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "user-driven", by: "orch" });
		const before = l.workload(w)!.rev;
		expect(reserve(l, w)).toEqual({ ok: false, reason: "user-driven" });
		expect(launches(l, w)).toHaveLength(0);
		expect(l.workload(w)).toMatchObject({ holder: null, rev: before });
		expect(reserve(l, "wl-nope")).toEqual({ ok: false, reason: "no such workload" });
		l.close();
	});

	test("the ordinal counts every launch: attempt; a second attempt after a release is lane-…-2", () => {
		const { ledger: l } = fresh("ordinal");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch", id: "wl-ord" });
		expect(reserve(l, w)).toMatchObject({ ok: true, laneId: "lane-ord-1" });
		expect(l.releaseWorkload(w, { by: LANE_STARTER_BY, holder: "lane-ord-1" })).toEqual({ released: true });
		// the policy would now refuse (one attempt exists); a policy that allows again mints the next ordinal
		const again = l.reserveLane(w, { by: LANE_STARTER_BY, cap: 3, leaseMs: 1000, requestedBy: "jo", receiptWorkload: RECEIPTS, decide: () => ({ launch: true, cause: "request en-x" }) });
		expect(again).toEqual({ ok: true, laneId: "lane-ord-2", cause: "request en-x" });
		expect(launches(l, w).map((e) => e.body)).toEqual(["launch: lane-ord-1 cause first requested-by test", "launch: lane-ord-2 cause request en-x requested-by jo"]);
		l.close();
	});

	test("the live-lane count sees lane-* holders under a live lease across workloads and ignores lapsed ones and Jo", () => {
		const { ledger: l } = fresh("live");
		const a = l.openWorkload({ brief: "a", stakes: "normal", mode: "autonomous", by: "orch" });
		const b = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch" });
		const c = l.openWorkload({ brief: "c", stakes: "normal", mode: "autonomous", by: "orch" });
		const d = l.openWorkload({ brief: "d", stakes: "normal", mode: "autonomous", by: "orch" });
		const seen: number[] = [];
		const spy = (rows: ReserveRows): ReserveVerdict => {
			seen.push(rows.liveLanes);
			return { launch: false, reason: "spy" };
		};
		const peek = (wl: string) => l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 1000, requestedBy: "t", receiptWorkload: RECEIPTS, decide: spy });
		l.claimWorkload(a, { by: "lane-a-1", holder: "lane-a-1", leaseMs: 60_000 });
		l.claimWorkload(b, { by: "lane-b-1", holder: "lane-b-1", leaseMs: 50 });
		l.claimWorkload(c, { by: "orch", holder: "jo", leaseMs: null });
		Bun.sleepSync(80);
		peek(d);
		expect(seen).toEqual([1]);
		l.close();
	});

	test("the receipt workload's raw instructions and assumption entries reach the policy, oldest first, inside the transaction", () => {
		const { ledger: l } = fresh("receipts");
		const r = l.openWorkload({ brief: "receipts", stakes: "normal", mode: "autonomous", by: "orch", id: RECEIPTS });
		const w = l.openWorkload({ brief: "w", stakes: "normal", mode: "autonomous", by: "orch" });
		const first = l.recordInstruction({ by: "surface", workloadId: r, body: "one", author: "jo", channel: "surface" });
		const second = l.recordInstruction({ by: "surface", workloadId: r, body: "two", author: "jo", channel: "surface" });
		const reading = l.recordEntry({ by: "surface", workloadId: r, kind: "assumption", body: "reading: x" });
		const seen: ReserveRows[] = [];
		const res = l.reserveLane(w, { by: LANE_STARTER_BY, cap: 3, leaseMs: 1000, requestedBy: "t", receiptWorkload: r, decide: (rows) => {
			seen.push(rows);
			return { launch: false, reason: "pending-model: waits" };
		} });
		expect(res).toEqual({ ok: false, reason: "pending-model: waits" });
		expect(seen[0]!.receiptInputs.map((i) => i.id)).toEqual([first, second]);
		expect(seen[0]!.receiptEntries.map((e) => e.id)).toEqual([reading]);
		expect(launches(l, w)).toHaveLength(0);
		expect(l.workload(w)!.holder).toBeNull();
		expect(l.launchRows(w, 3, r)!.receiptInputs.map((i) => i.body)).toEqual(["one", "two"]);
		l.close();
	});

	test("a launch decision with no receipt workload fails closed: it throws before reading or writing anything", () => {
		const { ledger: l } = fresh("no-receipts");
		const w = l.openWorkload({ brief: "w", stakes: "normal", mode: "autonomous", by: "orch" });
		let called = false;
		const spy = (): ReserveVerdict => {
			called = true;
			return { launch: true, cause: "first" };
		};
		for (const missing of [undefined, "", "   "]) {
			// A caller written against the old signature (no receiptWorkload) is not stopped by the type at run time.
			const input = { by: LANE_STARTER_BY, cap: 3, leaseMs: 1000, requestedBy: "t", receiptWorkload: missing, decide: spy } as unknown as Parameters<Ledger["reserveLane"]>[1];
			expect(() => l.reserveLane(w, input)).toThrow("names its receipt workload");
			expect(() => l.launchRows(w, 3, missing as unknown as string)).toThrow("names its receipt workload");
		}
		expect(called).toBe(false);
		expect(launches(l, w)).toHaveLength(0);
		expect(l.workload(w)!.holder).toBeNull();
		l.close();
	});

	test("concurrent starters across processes: 3 workloads × 3 processes each → exactly one lane per workload, distinct ordinals, the fourth workload refused by the cap, refusals write nothing", async () => {
		const { path, ledger: l } = fresh("concurrent");
		const wls = ["wl-c1", "wl-c2", "wl-c3", "wl-c4"].map((id) => l.openWorkload({ brief: id, stakes: "normal", mode: "autonomous", by: "orch", id }));
		l.close();
		// one starter per process, all started together; each reserves once under cap 3 and prints its result
		const worker = `
			import { Ledger, LANE_STARTER_BY } from ${JSON.stringify(join(REPO, "ledger", "src", "index.ts"))};
			const [path, wl] = process.argv.slice(-2);
			const l = Ledger.open(path);
			const decide = (rows) => {
				const w = rows.workload;
				if (w.holder !== null && (w.holder_lease_until === null || w.holder_lease_until >= rows.now)) return { launch: false, reason: "held" };
				if (rows.liveLanes >= rows.cap) return { launch: false, reason: "cap" };
				if (rows.entries.some((e) => e.body.startsWith("launch: "))) return { launch: false, reason: "died-not-relaunched" };
				return { launch: true, cause: "first" };
			};
			console.log(JSON.stringify(l.reserveLane(wl, { by: LANE_STARTER_BY, cap: 3, leaseMs: 180_000, requestedBy: "worker", receiptWorkload: ${JSON.stringify(RECEIPTS)}, decide })));
			l.close();`;
		const procs: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
		for (const wl of wls) for (let i = 0; i < 3; i++) procs.push(Bun.spawn(["bun", "-e", worker, "--", path, wl], { stdout: "pipe", stderr: "pipe" }));
		const outs = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() })));
		for (const o of outs) expect(o.code, o.err).toBe(0);
		const results = outs.map((o) => JSON.parse(o.out.trim()) as { ok: boolean; laneId?: string; reason?: string });
		const wins = results.filter((r) => r.ok);
		expect(wins).toHaveLength(3);
		expect(new Set(wins.map((r) => r.laneId)).size).toBe(3);
		const l2 = Ledger.open(path);
		const held = wls.filter((wl) => l2.workload(wl)!.holder !== null);
		expect(held).toHaveLength(3);
		for (const wl of wls) {
			const ls = launches(l2, wl);
			expect(ls.length).toBe(l2.workload(wl)!.holder === null ? 0 : 1);
			if (ls.length === 1) expect(ls[0]!.body).toBe(`launch: lane-${wl.slice(3)}-1 cause first requested-by worker`);
		}
		const refused = results.filter((r) => !r.ok).map((r) => r.reason);
		expect(refused.filter((r) => r === "cap").length).toBeGreaterThanOrEqual(3);
		l2.close();
	});
});

describe("parkLane (decision 14)", () => {
	const setup = () => {
		const { ledger: l } = fresh("park");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch", id: "wl-park" });
		expect(reserve(l, w)).toMatchObject({ ok: true, laneId: "lane-park-1" });
		const sl = l.addSlice({ by: "lane-park-1", workloadId: w, task: "t", doneCondition: "d", inputs: "i" });
		const q = l.raiseQuestion({ by: "lane-park-1", workloadId: w, sliceId: sl, body: "which?", options: ["a", "b"] });
		return { l, w, sl, q };
	};
	const park = (l: Ledger, w: string) => l.parkLane(w, { by: LANE_RUNNER_BY, laneId: "lane-park-1", session: "/s/one.jsonl" });
	const parked = (l: Ledger, w: string) => l.entries(w, "assumption").filter((e) => e.body.startsWith("lane-parked: "));

	test("an open question this lane raised parks it, in one entry naming the question and the session", () => {
		const { l, w, q } = setup();
		expect(park(l, w)).toEqual({ parked: true, open: 1 });
		expect(parked(l, w).map((e) => ({ by: e.created_by, body: e.body }))).toEqual([{ by: LANE_RUNNER_BY, body: `lane-parked: lane-park-1 questions ${q} session /s/one.jsonl` }]);
		l.close();
	});

	test("a question answered while the lane wound down parks it as resume-pending (open 0); one already consumed by a launch: does not", () => {
		const { l, w, q } = setup();
		const iid = l.answerQuestion(q, { by: "orchestrator-surface", answer: "a", author: "jo", channel: "surface" });
		expect(park(l, w)).toEqual({ parked: true, open: 0 });
		l.recordEntry({ by: LANE_STARTER_BY, workloadId: w, kind: "assumption", body: `launch: lane-park-2 cause resume ${iid} requested-by tick` });
		expect(park(l, w)).toEqual({ parked: false });
		l.close();
	});

	test("a cancel withdrawal is not a resolution; another lane's question is not this lane's; no questions → not parked", () => {
		const { l, w, q } = setup();
		l.withdrawQuestion(q, { by: "orchestrator-surface", reason: "drop", author: "jo", channel: "surface", then: "cancel" });
		expect(park(l, w)).toEqual({ parked: false });
		const sl2 = l.addSlice({ by: "lane-park-9", workloadId: w, task: "t2", doneCondition: "d", inputs: "i" });
		l.raiseQuestion({ by: "lane-park-9", workloadId: w, sliceId: sl2, body: "other lane", options: ["x", "y"] });
		expect(park(l, w)).toEqual({ parked: false });
		expect(parked(l, w)).toHaveLength(0);
		l.close();
	});

	test("a replan withdrawal is a resolution", () => {
		const { l, w, q } = setup();
		l.withdrawQuestion(q, { by: "orchestrator-surface", reason: "again", author: "jo", channel: "surface", then: "replan" });
		expect(park(l, w)).toEqual({ parked: true, open: 0 });
		l.close();
	});
});

describe("handoffWorkload (§ B5 'I've got X')", () => {
	test("the holder hands the workload to jo with no lease, passing workloads_holder_no_steal; a non-holder is refused and told who holds", () => {
		const { ledger: l } = fresh("handoff");
		const w = l.openWorkload({ brief: "b", stakes: "normal", mode: "autonomous", by: "orch" });
		l.claimWorkload(w, { by: "lane-h-1", holder: "lane-h-1", leaseMs: 60_000 });
		expect(l.handoffWorkload(w, { by: "lane-h-2", holder: "lane-h-2", to: "jo" })).toEqual({ ok: false, holder: "lane-h-1" });
		expect(l.workload(w)!.holder).toBe("lane-h-1");
		expect(l.handoffWorkload(w, { by: "lane-h-1", holder: "lane-h-1", to: "jo" })).toEqual({ ok: true });
		expect(l.workload(w)).toMatchObject({ holder: "jo", holder_lease_until: null });
		// once jo holds with no lease, a lane's claim cannot win it back
		expect(l.claimWorkload(w, { by: "lane-h-1", holder: "lane-h-1", leaseMs: 60_000 })).toMatchObject({ won: false, holder: "jo" });
		l.close();
	});
});
