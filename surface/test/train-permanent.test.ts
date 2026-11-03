// The one permanent merge train (PLAN wl-mvr888nftz0vcl D2, D3, D4, D11, D13; lane decision en-mvznmxcdh0ucsj): the board
// side of R1 (append to the one train, open one only when none is open, another repository refused with one
// `train-board-refused:` row, a PR boarded again on its next attempt once the current one is terminal), R2 (no close and no
// done-because on a train, its receipt never read, a train's fix workload still closes), R3 (the lower-ceiling tool refuses a
// train) and R25 (a train lane's release with open slices is a quiet idle release). Every case runs on a real temp ledger;
// the tools run through the extension as the surface loads it.
import { describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_STARTER_BY, Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { closeWorkloadWithEntry } from "../extensions/workload";
import orchestratorSurface from "../index";
import { TEST_RUNNER_CONFIG_ENV } from "../src/close-entry";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { apply, applyTrain, interpret } from "../src/input";
import { controlEntries, exitClass, holdersOf, launchRowsFor, trainBoardBody, trainFixBody, verdictOf } from "../src/launch";
import {
	boardLanding, boardRefusals, isTrain, type Landing, landingReady, openTrains, parseTrainSlice, TRAIN_DONE, trainAttemptFor, trainAttemptsOf, trainAutoboardBody,
	trainFullSliceId, trainPrs, trainSliceId,
} from "../src/merge-train";
import { makeRunId, testRequestedBody, testRunBody } from "../src/test-run";
import { releasedIdle, releasedOpen } from "../src/turn-end";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI } from "../src/types";
import { clock, ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const ORIGIN = "thewolff/product";
const OTHER = "thewolff/other";
const CTX = { config: { repos: [{ origin: ORIGIN, command: "bun test" }, { origin: OTHER, command: "bun test" }] } };
const G = "a".repeat(40);
const H = "b".repeat(40);
const LANE = "lane-t-1";

/** A git checkout at a temp path whose origin is github `origin`. */
function checkout(origin: string): string {
	const dir = realpathSync(tmp("permanent-repo"));
	for (const args of [["init", "-q"], ["config", "remote.origin.url", `https://github.com/${origin}.git`]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${dir} failed: ${r.stderr.toString()}`);
	}
	return dir;
}

/** A temp ledger on a settable clock with the standing workload, the tick's cutover row, and checkouts of ORIGIN and OTHER. */
function world() {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const repos = { [ORIGIN]: checkout(ORIGIN), [OTHER]: checkout(OTHER) };
	c.plusHours(0.01);
	ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainAutoboardBody(c.now()) });
	c.plusHours(0.01);
	let seq = 0;
	/** A lane workload W as its lane leaves it ready to board (D1): green full suite on PR `pr` at `sha`, a passed review, done-because, closed. */
	const landing = (pr: number, sha = G, origin = ORIGIN): string => {
		const holder = `lane-l-${++seq}`;
		const wl = ledger.openWorkload({ by: SURFACE_BY, brief: `Fix the header (#${pr})`, stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, wl, repos[origin]!);
		expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder, leaseMs: 600_000 }).won).toBe(true);
		const sl = ledger.addSlice({ by: holder, workloadId: wl, task: "change", doneCondition: "tests pass", inputs: "src" });
		const runId = makeRunId(Date.parse(c.now()) + seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr, sha, slice: sl, by: holder }) });
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId, verdict: "green", sha, pr, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: 0, skip: 0, exit: 0, ms: 10, error: null }, solo: [], failures: [], runDir: null, preflight: null,
			}),
		});
		ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewRoundBody({ slice: sl, round: 1, token: `dt-${seq}`, group: `dg-${seq}`, verdict: "accepted", findings: UNKNOWN }) });
		ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLoopEndBody(sl, "pass") });
		ledger.completeSlice(sl, { by: holder, artifact: "done" });
		c.plusHours(0.01);
		ledger.recordEntry({ by: holder, workloadId: wl, kind: "assumption", body: "done-because: the header is fixed" });
		ledger.releaseWorkload(wl, { by: holder, holder });
		ledger.closeWorkload(wl, { by: SURFACE_BY });
		c.plusHours(0.01);
		return wl;
	};
	const ready = (wl: string): Extract<Landing, { ready: true }> => {
		const l = landingReady(ledger, wl, CTX);
		if (!l.ready) throw new Error(`${wl} is not ready to board: ${l.reason}`);
		return l;
	};
	const board = (wl: string) => {
		const r = boardLanding(ledger, ready(wl));
		c.plusHours(0.01);
		return r;
	};
	const workloads = () => ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
	return { c, ledger, repos, landing, ready, board, workloads };
}

describe("R1, the board side: one train, appended to, opened only when none is open", () => {
	test("no train open: the first board opens the one train (done: TRAIN_DONE, repo: the checkout); every later board appends to it", () => {
		const w = world();
		expect(openTrains(w.ledger)).toEqual([]);
		const first = w.board(w.landing(117));
		if (!first.boarded) throw new Error(first.reason);
		expect(first.opened).toBe(true);
		const train = first.train;
		const bodies = w.ledger.entries(train).map((e) => e.body);
		expect(bodies).toContain(`done: ${TRAIN_DONE}`);
		expect(bodies).toContain(`repo: ${w.repos[ORIGIN]}`);
		const before = w.workloads();
		for (const pr of [118, 119]) {
			const r = w.board(w.landing(pr));
			expect(r).toMatchObject({ boarded: true, train, opened: false });
		}
		// two landing workloads, no new train
		expect(w.workloads()).toBe(before + 2);
		expect(openTrains(w.ledger)).toEqual([train]);
		expect(trainPrs(w.ledger.entries(train), w.ledger.instructions(train))).toEqual([117, 118, 119]);
		expect(isTrain(w.ledger, train)).toBe(true);
	});

	test("a PR of another repository is refused, writing one train-board-refused: row naming its workload however often it is tried, and opens no train", () => {
		const w = world();
		const first = w.board(w.landing(117));
		if (!first.boarded) throw new Error(first.reason);
		const other = w.landing(5, G, OTHER);
		const before = w.workloads();
		const trainEntries = w.ledger.entries(first.train);
		for (let attempt = 0; attempt < 3; attempt++) {
			const r = w.board(other);
			expect(r.boarded).toBe(false);
			if (r.boarded) continue;
			expect(r.reason).toStartWith(`merge train ${first.train} serves ${w.repos[ORIGIN]}, not ${OTHER}: #5 is not boarded (train-board-refused: pr 5 repo ${OTHER} workload ${other})`);
		}
		// W is closed, so the row is on the standing workload, naming W (the ledger takes no entry on a closed workload)
		const refused = controlEntries(w.ledger.entries(STANDING_WORKLOAD_ID)).filter((c) => c.prefix === "train-board-refused");
		expect(refused.map((c) => [c.createdBy, c.body.trim()])).toEqual([[MERGE_TRAIN_BY, `train-board-refused: pr 5 repo ${OTHER} workload ${other}`]]);
		expect(boardRefusals(w.ledger).map((r) => [r.workloadId, r.pr, r.repo])).toEqual([[other, 5, OTHER]]);
		expect(w.workloads()).toBe(before);
		expect(openTrains(w.ledger)).toEqual([first.train]);
		expect(w.ledger.entries(first.train)).toEqual(trainEntries);
	});

	test("lane decision en-mvznmxcdh0ucsj: a PR whose attempt is open is refused; once terminal it boards again as attempt 2 at a new head", () => {
		const w = world();
		const first = w.board(w.landing(117));
		if (!first.boarded) throw new Error(first.reason);
		const train = first.train;
		const k = train.replace(/^wl-/, "");
		expect(trainAttemptFor(w.ledger, train, 117)).toEqual({ ok: false, reason: `#117 is already on open merge train ${train}` });
		expect(trainAttemptFor(w.ledger, train, 999)).toEqual({ ok: true, attempt: 1, sliceId: `sl-train-${k}-999` });
		// the train lane works #117: its attempt-1 slice is open, so a new landing of #117 is refused, naming it
		const sl1 = w.ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117), task: "PR #117", doneCondition: "terminal", inputs: "#117" });
		expect(sl1).toBe(`sl-train-${k}-117`);
		const again = w.landing(117, H);
		const entries = w.ledger.entries(train);
		expect(w.board(again)).toEqual({ boarded: false, reason: `#117 is already on merge train ${train} (${sl1} open)` });
		expect(w.ledger.entries(train)).toEqual(entries);
		// it goes back to its owner: the slice is terminal, and the next landing at a new head takes attempt 2
		w.ledger.cancelSlice(sl1, { by: LANE });
		expect(trainAttemptFor(w.ledger, train, 117)).toEqual({ ok: true, attempt: 2, sliceId: `sl-train-${k}-117-a2` });
		w.c.plusHours(0.01);
		expect(w.board(again)).toMatchObject({ boarded: true, train, opened: false });
		expect(openTrains(w.ledger)).toEqual([train]);
		expect(trainAttemptsOf(w.ledger, train).get(117)?.attempt).toBe(2);
		expect(trainPrs(w.ledger.entries(train), w.ledger.instructions(train))).toEqual([117]);
		// attempt 2 is not added yet: a third boarding is refused until it is terminal
		expect(trainAttemptFor(w.ledger, train, 117)).toEqual({ ok: false, reason: `#117 is already on open merge train ${train}` });
		const sl2 = w.ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117, 2), task: "PR #117 again", doneCondition: "terminal", inputs: "#117" });
		expect(trainAttemptFor(w.ledger, train, 117)).toEqual({ ok: false, reason: `#117 is already on merge train ${train} (${sl2} open)` });
		w.ledger.completeSlice(sl2, { by: LANE, artifact: "merged by train" });
		expect(trainAttemptFor(w.ledger, train, 117)).toEqual({ ok: true, attempt: 3, sliceId: `sl-train-${k}-117-a3` });
	});

	test("attempt-numbered slice ids: attempt 1 keeps sl-train-<k>-<n>; attempt m is -a<m>, its suite runs -a<m>-full-<r>", () => {
		const t = "wl-abc123";
		expect(trainSliceId(t, 7)).toBe("sl-train-abc123-7");
		expect(trainSliceId(t, 7, 2)).toBe("sl-train-abc123-7-a2");
		expect(trainFullSliceId(t, 7, 3)).toBe("sl-train-abc123-7-full-3");
		expect(trainFullSliceId(t, 7, 1, 12)).toBe("sl-train-abc123-7-a12-full-1");
		expect(parseTrainSlice("sl-train-abc123-7", t)).toEqual({ pr: 7, attempt: 1, full: null });
		expect(parseTrainSlice("sl-train-abc123-7-a2-full-3", t)).toEqual({ pr: 7, attempt: 2, full: 3 });
		expect(parseTrainSlice("sl-train-abc123-7-a1", t)).toBeNull();
		expect(parseTrainSlice("sl-train-abc123-7-a2", "wl-other")).toBeNull();
		expect(parseTrainSlice("sl-plan", t)).toBeNull();
	});
});

describe("review r1 F3: a PR's attempt is decided in its membership transaction, never inferred from a slice later", () => {
	const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
	/** Every `train-attempt:` row on `train`, as [writer, body, created_at]. */
	const attemptRows = (ledger: Ledger, train: string) =>
		ledger.entries(train).filter((e) => e.body.startsWith("train-attempt:")).map((e) => [e.created_by, e.body, e.created_at]);
	/** Jo's train opened by `train 117` on a ledger stamped by a settable clock, and #117's attempt-1 slice, opened by the train lane. */
	const joWorld = () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const train = joTrain(ledger);
		c.plusHours(0.01);
		const sl1 = ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117), task: "PR #117", doneCondition: "terminal", inputs: "#117" });
		return { c, ledger, train, sl1 };
	};

	test("(a) Jo's `train <wl> 117` resuming a held train while #117's attempt-1 slice is open writes no train-attempt row; #117 stays on attempt 1 after that slice is cancelled in the resume's millisecond", () => {
		const { c, ledger, train, sl1 } = joWorld();
		const q = ledger.raiseQuestion({ by: LANE, workloadId: train, sliceId: sl1, body: "#117 production: merge it?", options: ["merged", "skip", "stop"] });
		ledger.answerQuestion(q, { ...JO, answer: "stop" });
		c.plusHours(0.01);
		const receipt = apply(ledger, interpret(ledger, `train ${train} 117`)!);
		expect(receipt).toStartWith(`added #117 to merge train ${train} (instruction `);
		const resume = ledger.entries(train).filter((e) => e.body.startsWith("train: 117 ")).at(-1)!;
		expect(attemptRows(ledger, train)).toEqual([]);
		expect(trainAttemptsOf(ledger, train).get(117)?.attempt).toBe(1);
		// the clock is not moved: the slice turns terminal in the resume row's own millisecond
		ledger.cancelSlice(sl1, { by: LANE });
		expect(ledger.slice(sl1)!.changed_at).toBe(resume.created_at);
		expect(trainAttemptsOf(ledger, train).get(117)).toEqual({ attempt: 1, since: ledger.entries(train).find((e) => e.body.startsWith("train: 117 "))!.created_at });
		expect(attemptRows(ledger, train)).toEqual([]);
	});

	test("(b) Jo's word: a terminal attempt-1 slice, then `train <wl> 117` in the same millisecond, starts attempt 2 and writes its row as the surface", () => {
		const { c, ledger, train, sl1 } = joWorld();
		c.plusHours(0.01);
		ledger.cancelSlice(sl1, { by: LANE });
		const receipt = apply(ledger, interpret(ledger, `train ${train} 117`)!);
		expect(receipt).toStartWith(`added #117 (attempt 2) to merge train ${train} (instruction `);
		const at = ledger.slice(sl1)!.changed_at;
		expect(attemptRows(ledger, train)).toEqual([[SURFACE_BY, "train-attempt: pr 117 attempt 2", at]]);
		expect(trainAttemptsOf(ledger, train).get(117)).toEqual({ attempt: 2, since: at });
	});

	test("(b) boardLanding: a terminal attempt-1 slice, then a re-board in the same millisecond, starts attempt 2 and writes its row as the merge train", () => {
		const w = world();
		const first = w.board(w.landing(117));
		if (!first.boarded) throw new Error(first.reason);
		const train = first.train;
		const sl1 = w.ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117), task: "PR #117", doneCondition: "terminal", inputs: "#117" });
		const again = w.landing(117, H);
		// no clock move from here: the cancel and the board share a millisecond
		w.ledger.cancelSlice(sl1, { by: LANE });
		const r = boardLanding(w.ledger, w.ready(again));
		expect(r).toMatchObject({ boarded: true, train, opened: false });
		const at = w.ledger.slice(sl1)!.changed_at;
		expect(attemptRows(w.ledger, train)).toEqual([[MERGE_TRAIN_BY, "train-attempt: pr 117 attempt 2", at]]);
		expect(trainAttemptsOf(w.ledger, train).get(117)).toEqual({ attempt: 2, since: at });
	});

	test("(c) a membership with no train-attempt row reads as attempt 1, even a second train-board: written after attempt 1's slice turned terminal", () => {
		const w = world();
		const first = w.board(w.landing(117));
		if (!first.boarded) throw new Error(first.reason);
		const train = first.train;
		const sl1 = w.ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117), task: "PR #117", doneCondition: "terminal", inputs: "#117" });
		w.ledger.cancelSlice(sl1, { by: LANE });
		const again = w.landing(117, H);
		// a membership row as one written before train-attempt: rows existed: the board alone, no attempt row beside it
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: trainBoardBody({ pr: 117, workload: again, head: H, run: null, review: null }) });
		expect(trainPrs(w.ledger.entries(train), w.ledger.instructions(train))).toEqual([117]);
		expect(attemptRows(w.ledger, train)).toEqual([]);
		const firstBoard = w.ledger.entries(train).find((e) => e.body.startsWith("train-board: pr 117 "))!;
		expect(trainAttemptsOf(w.ledger, train).get(117)).toEqual({ attempt: 1, since: firstBoard.created_at });
	});
});

/** A train opened by Jo's `train 117` on a checkout of ORIGIN, on a ledger at `path`. */
function joTrain(ledger: Ledger): string {
	const cmd = interpret(ledger, "train 117");
	if (cmd?.kind !== "train") throw new Error("`train 117` did not interpret as the train word");
	return applyTrain(ledger, cmd, checkout(ORIGIN)).workloadId;
}

const pi = { appendEntry: () => {} } as unknown as SurfaceAPI;

describe("R2: the train is never closed and takes no done-because; its fix workload is ordinary", () => {
	test("closeWorkloadWithEntry refuses the train, writing nothing, and the train stays open", async () => {
		const { ledger } = tempLedger();
		const train = joTrain(ledger);
		const entries = ledger.entries(train);
		const r = await closeWorkloadWithEntry(pi, ledger, {}, train, { now: ledger.now(), cwd: tmp("permanent-close"), receipt: null });
		expect(r.closed).toBe(false);
		expect(r.text).toBe(`close refused: ${train} is the merge train, and the merge train is permanent: it is never closed, withdrawn or superseded, and it takes no done-because (USER-GUIDE.md § 3, The merge train); nothing was written.`);
		expect(ledger.workload(train)!.status).toBe("open");
		expect(ledger.entries(train)).toEqual(entries);
	});

	test("a train's fix workload is no train: it closes as any workload does", async () => {
		const root = realpathSync(tmp("permanent-fix"));
		writeFileSync(join(root, "config.yml"), "setupVersion: 2\n");
		const { ledger } = tempLedger();
		const train = joTrain(ledger);
		const trainEntry = ledger.entries(train)[0]!.id;
		const fix = ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "Fix #117 for the train", stakes: "normal", mode: "autonomous" });
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: fix, kind: "assumption", body: trainFixBody({ repo: ORIGIN, pr: 117, train, trainEntry }) });
		recordRepo(ledger, fix, root);
		expect(isTrain(ledger, fix)).toBe(false);
		const r = await closeWorkloadWithEntry(pi, ledger, { [TEST_RUNNER_CONFIG_ENV]: join(root, "config.yml") }, fix, { now: ledger.now(), cwd: root, receipt: null });
		expect(r.text).not.toContain("merge train is permanent");
		expect(r.closed).toBe(true);
		expect(ledger.workload(fix)!.status).toBe("closed");
	});

	test("verdictOf reads a train's standing done-because as no receipt; an ordinary workload's is awaiting-close", () => {
		const { ledger } = tempLedger();
		const train = joTrain(ledger);
		const plain = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the header", stakes: "normal", mode: "autonomous" });
		for (const wl of [train, plain]) {
			ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
			expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 600_000 }).won).toBe(true);
			// a legacy row: written straight to the ledger, as before D3 refused it
			ledger.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: "done-because: the PRs are merged" });
			ledger.releaseWorkload(wl, { by: LANE, holder: LANE });
		}
		const verdict = (wl: string) => {
			const rows = launchRowsFor(ledger, wl, 4);
			if (rows === null) throw new Error(`launchRowsFor(${wl}) read no rows`);
			return verdictOf(rows);
		};
		expect(verdict(plain)).toEqual({ launch: false, reason: "awaiting-close" });
		expect(verdict(train)).not.toEqual({ launch: false, reason: "awaiting-close" });
	});
});

/** A lane extension on `wl` held by LANE, through the surface as a lane loads it. */
function laneOn(path: string, wl: string) {
	const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: wl, AGENT_SYSTEM_LANE_ID: LANE, HOME: "/nonexistent-home" };
	const f = fakePi(undefined, { exec: false });
	orchestratorSurface(f.pi, env, {});
	const ctx = ctxOf();
	const call = async (tool: string, params: Record<string, unknown>) => (await f.tool(tool).execute("1", params, undefined, undefined, ctx)).content[0]!.text;
	return { ctx, call };
}

/** Jo's train, with LANE launched and holding it, on a ledger the tools open at `path`. */
function heldTrain() {
	const { ledger, path } = tempLedger();
	const train = joTrain(ledger);
	ledger.recordEntry({ by: LANE_STARTER_BY, workloadId: train, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	expect(ledger.claimWorkload(train, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 600_000 }).won).toBe(true);
	return { ledger, path, train };
}

describe("R2 and R25: the train lane's tools", () => {
	test("R2: lane_record_entry refuses a done-because on the train, writing nothing", async () => {
		const { ledger, path, train } = heldTrain();
		const { call } = laneOn(path, train);
		const before = ledger.entries(train).length;
		const text = await call("lane_record_entry", { body: "done-because: every PR is merged" });
		expect(text).toStartWith(`done-because refused: ${train} is the merge train, and the merge train is permanent`);
		expect(text).toContain("lane_release with no done-because");
		expect(ledger.entries(train)).toHaveLength(before);
		expect(ledger.entries(train).some((e) => e.body.startsWith("done-because:"))).toBe(false);
		// an ordinary entry still records
		expect(await call("lane_record_entry", { body: "working #117 first" })).not.toContain("refused");
	});

	test("R25: lane_release on the train with open slices writes released-idle:, never released-open:, and its exit is intended", async () => {
		const { ledger, path, train } = heldTrain();
		ledger.addSlice({ by: LANE, workloadId: train, id: trainSliceId(train, 117), task: "PR #117", doneCondition: "terminal", inputs: "#117" });
		const { ctx, call } = laneOn(path, train);
		expect(await call("lane_release", {})).toContain("Released");
		expect(ctx.shutdowns).toHaveLength(1);
		expect(ledger.workload(train)!.holder).toBeNull();
		const entries = ledger.entries(train);
		const control = controlEntries(entries, holdersOf(entries, null, ledger.holders(train)));
		expect(entries.filter((e) => e.body.startsWith("released-")).map((e) => [e.created_by, e.body])).toEqual([[LANE, `released-idle: ${LANE} open 1`]]);
		expect(releasedIdle(control, LANE)).toBe(true);
		expect(releasedOpen(control, LANE)).toBeNull();
		expect(exitClass(control, LANE)).toBe("intended");
	});
});

describe("R3: the orchestrator's lower-ceiling tool refuses the train", () => {
	test("refused, naming the daily budget, and nothing is written; a train's fix workload is lowered as before", async () => {
		const voice = join(tmp("voice"), "VOICE.md");
		writeFileSync(voice, "VOICE");
		const db = join(tmp("ledger"), "ledger.db");
		const env = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: db, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" };
		const seed = Ledger.open(db, { create: true, backup: false, backupOnOpen: false });
		const train = joTrain(seed);
		const fix = seed.openWorkload({ by: MERGE_TRAIN_BY, brief: "Fix #117 for the train", stakes: "normal", mode: "autonomous" });
		seed.recordEntry({ by: MERGE_TRAIN_BY, workloadId: fix, kind: "assumption", body: trainFixBody({ repo: ORIGIN, pr: 117, train, trainEntry: seed.entries(train)[0]!.id }) });
		seed.recordEntry({ by: SURFACE_BY, workloadId: fix, kind: "assumption", body: "ceiling: usd 50 wall 360 source stakes normal" });
		const before = seed.entries(train);
		seed.close();
		const f = fakePi();
		orchestratorSurface(f.pi, env, {});
		const ctx = ctxOf();
		const lower = async (params: Record<string, unknown>) => (await f.tool("orchestrator_lower_ceiling").execute("1", params, undefined, undefined, ctx)).content[0]!.text;
		for (const params of [{ usd: "20" }, { wallMinutes: "60" }, { usd: "1", wallMinutes: "1" }]) {
			const text = await lower({ workloadId: train, ...params });
			expect(text).toStartWith(`Refused: ${train} is the merge train, which has no ceiling and no wall: it spends at most $`);
			expect(text).toEndWith("nothing was written.");
		}
		expect(await lower({ workloadId: fix, usd: "20" })).toContain(`Lowered the ceiling on ${fix} from $50 / 6h to $20 / 6h`);
		const l = Ledger.open(db, { create: false, backup: false, backupOnOpen: false });
		try {
			expect(l.entries(train)).toEqual(before);
		} finally {
			l.close();
		}
	});
});
