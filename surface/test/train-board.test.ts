// Auto-boarding, the core half (PLAN wl-mvbjiettjrfpxc D1-D3, D5): `landingReady` (the ledger half of "a lane finished
// green"), `boardLanding` (reuse the repository's newest open train, or leave the PR pending when held or done),
// membership through `train-board:` (`trainMembers`, `boundPrs`, `openTrains`, `actionable`), the writer rule (MERGE_TRAIN_BY only) and the
// void-board rule. Every case runs on a real temp ledger with a temp git checkout whose origin is a fake GitHub URL.
import { describe, expect, test } from "bun:test";
import { reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_RUNNER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import { ceilingBody, spendBody } from "../src/ceiling";
import { trainPrsOn } from "../src/close-entry";
import { ensureStandingWorkload } from "../src/identity";
import { applyTrain, interpret } from "../src/input";
import {
	boundPrs, controlEntries, landFirstBody, landFirstInstructionBody, parseTrainBoard, planApprovedBody, planFirstBody, planQuestionBody, reservedPrefix, trainBoardBody, trainFixBody,
} from "../src/launch";
import {
	actionable, AUTOBOARD_WINDOW_MS, autoboardCutover, boardLanding, isTrainOrFix, type Landing, landingReady, openTrains, protectionGap, TRAIN_DONE, trainAutoboardBody, trainMembers,
	trainAttemptFor, trainAttemptsOf, trainPrs, trainSignoff, trainSliceId, PRODUCTION_FAST_GREEN,
} from "../src/merge-train";
import { makeRunId, testRequestedBody, testRunBody, type TestVerdict } from "../src/test-run";
import { MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const ORIGIN = "thewolff/product";
const CTX = { config: { repos: [{ origin: ORIGIN, command: "bun test" }] } };
const JO = { by: SURFACE_BY, author: "jo", channel: "surface" as const };
const G = "a".repeat(40);
const H = "b".repeat(40);

/** A git checkout at a temp path whose origin is `url`. */
function checkout(url: string): string {
	const dir = tmp("board-repo");
	for (const args of [["init", "-q"], ["config", "remote.origin.url", url]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	}
	return dir;
}

/** The test world: the ledger, its settable clock, and the served checkout. */
interface World {
	c: { now: () => string; at: (iso: string) => void; plusHours: (h: number) => void };
	ledger: Ledger;
	repo: string;
}

/** A temp ledger on a settable clock, the standing workload, a served checkout, and (unless `cutover` is false) the tick's cutover row. */
function world(cutover = true): World {
	const c = clock();
	const { ledger } = tempLedger(c.now);
	ensureStandingWorkload(ledger);
	const repo = checkout(`https://github.com/${ORIGIN}.git`);
	c.plusHours(0.01);
	if (cutover) ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainAutoboardBody(c.now()) });
	c.plusHours(0.01);
	return { c, ledger, repo };
}
function landFirst(w: World, on = true): void {
	const id = w.ledger.recordInstruction({ ...JO, workloadId: STANDING_WORKLOAD_ID, body: landFirstInstructionBody(ORIGIN, on) });
	w.ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: landFirstBody(ORIGIN, on, id) });
}


interface LaneOpts {
	stakes?: "throwaway" | "normal" | "production";
	mode?: "autonomous" | "user-driven";
	pr?: number;
	verdict?: TestVerdict | "none";
	/** The run's scope: the full suite (default) or the land-first fast check (PLAN wl-mvq4edbaf13vnk D1). */
	scope?: "full" | "fast";
	/** The review on the lane's change slice: a round then its end, a round alone, an end then a fresh round, or none. */
	review?: "pass" | "accept" | "stop" | "round-only" | "reopened" | "none";
	/** A loop end written by another writer than the holder lane. */
	endBy?: string;
	/** The only review is on the plan question's slice. */
	planOnly?: boolean;
	done?: boolean;
	close?: boolean;
	repo?: string;
	extra?: (ledger: Ledger, wl: string) => void;
}

let seq = 0;
/** A lane workload W as the lane leaves it: its change slice, a full-suite run on PR n at G, a review, done-because, released, closed. */
function lane(w: World, o: LaneOpts = {}): string {
	const { ledger, c } = w;
	const holder = `lane-l-${++seq}`;
	const pr = o.pr ?? 101;
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the header", stakes: o.stakes ?? "normal", mode: o.mode ?? "autonomous" });
	ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: `repo: ${o.repo ?? w.repo}` });
	expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder, leaseMs: 600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: holder, workloadId: wl, task: "change", doneCondition: "tests pass", inputs: "src" });
	const verdict = o.verdict ?? "green";
	if (verdict !== "none") {
		const runId = makeRunId(Date.parse(c.now()) + seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId, pr, sha: G, slice: sl, by: holder }) });
		const full = { pass: 1, fail: verdict === "red" ? 1 : 0, skip: 0, exit: verdict === "red" ? 1 : 0, ms: 10, error: null };
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha: G, pr, reason: verdict === "green" || verdict === "red" ? null : "why", headAtEnd: G, base: null, mergeBase: null,
				full, solo: [], failures: verdict === "red" ? [{ part: "full", name: "x.test.ts > a", firstError: "boom" }] : [], runDir: null, preflight: null,
				...(o.scope === "fast" ? { scope: "fast" as const, host: "linux" as const } : {}),
			}),
		});
	}
	let reviewed = sl;
	if (o.planOnly) {
		reviewed = ledger.addSlice({ by: holder, workloadId: wl, task: "plan", doneCondition: "approved", inputs: "brief" });
		const q = ledger.raiseQuestion({ by: holder, workloadId: wl, sliceId: reviewed, body: "/plan.md", options: ["approve", "revise", "cancel"] });
		ledger.recordEntry({ by: holder, workloadId: wl, sliceId: reviewed, kind: "assumption", body: planQuestionBody(q) });
		ledger.answerQuestion(q, { ...JO, answer: "approve" });
	}
	const round = () => ledger.recordEntry({
		by: holder, workloadId: wl, sliceId: reviewed, kind: "assumption",
		body: reviewRoundBody({ slice: reviewed, round: 1, token: `dt-${seq}`, group: `dg-${seq}`, verdict: "accepted", findings: UNKNOWN }),
	});
	const end = (reason: "pass" | "accept" | "stop") =>
		ledger.recordEntry({ by: o.endBy ?? holder, workloadId: wl, sliceId: reviewed, kind: "assumption", body: reviewLoopEndBody(reviewed, reason) });
	const review = o.review ?? "pass";
	if (review !== "none") round();
	if (review === "pass" || review === "accept" || review === "stop") end(review);
	if (review === "reopened") {
		end("pass");
		round();
	}
	o.extra?.(ledger, wl);
	for (const s of ledger.slices(wl)) if (s.state === "open") ledger.completeSlice(s.id, { by: holder, artifact: "done" });
	c.plusHours(0.01);
	if (o.done !== false) ledger.recordEntry({ by: holder, workloadId: wl, kind: "assumption", body: "done-because: the header is fixed" });
	ledger.releaseWorkload(wl, { by: holder, holder });
	c.plusHours(0.01);
	if (o.close !== false) ledger.closeWorkload(wl, { by: SURFACE_BY });
	c.plusHours(0.01);
	return wl;
}

const ready = (l: Landing): Extract<Landing, { ready: true }> => {
	if (!l.ready) throw new Error(`not ready: ${l.reason}`);
	return l;
};

describe("landingReady, the ledger half of D1 (R1, R2)", () => {
	test("R1: a closed autonomous normal lane with done-because, a green full suite at G on PR n and a passed review is ready, naming its run and review", () => {
		const w = world();
		const wl = lane(w, { pr: 117 });
		const l = ready(landingReady(w.ledger, wl, CTX));
		const entries = w.ledger.entries(wl);
		expect([l.workloadId, l.pr, l.sha, l.repo]).toEqual([wl, 117, G, ORIGIN]);
		expect(l.run).toBe(entries.find((e) => e.body.startsWith("test-requested:"))!.body.match(/tr-[a-z0-9]+/)![0]);
		expect(l.review).toBe(entries.find((e) => e.body.startsWith("review-loop-end:"))!.id);
		// Jo's accept (the surface) is a passed review too
		const accepted = lane(w, { review: "accept", endBy: SURFACE_BY });
		expect(landingReady(w.ledger, accepted, CTX).ready).toBe(true);
	});

	test("R22: the fast check's green boards like a full green; a stale fast run does not", () => {
		const w = world();
		landFirst(w);
		const wl = lane(w, { pr: 118, scope: "fast", close: false });
		const l = ready(landingReady(w.ledger, wl, CTX));
		expect(l.pr).toBe(118);
		expect(boardLanding(w.ledger, l)).toMatchObject({ boarded: true, opened: true });
		expect(w.ledger.workload(wl)!.status).toBe("open");
		expect(landingReady(w.ledger, lane(w, { pr: 119, verdict: "stale", scope: "fast", close: false }), CTX)).toMatchObject({ ready: false, reason: expect.stringMatching(/ is stale$/) });
	});

	test("production fast green needs Jo's train word, not full scope: signoff on, refused off, never auto-boarded", () => {
		const w = world();
		landFirst(w);
		const wl = lane(w, { pr: 120, stakes: "production", scope: "fast" });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: PRODUCTION_FAST_GREEN });
		const command = interpret(w.ledger, "train 120");
		if (command?.kind !== "train") throw new Error("train 120 was not interpreted as a train");
		const train = applyTrain(w.ledger, command, w.repo).workloadId;
		const view = { number: 120, headRefName: `wl/${wl}`, headRefOid: G, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
		expect(trainSignoff(w.ledger, train, 120, view, ORIGIN, { state: "ok" })).toMatchObject({ ok: true, pr: 120, head: G });
		landFirst(w, false);
		expect(trainSignoff(w.ledger, train, 120, view, ORIGIN, { state: "ok" })).toMatchObject({ ok: false, reason: expect.stringContaining("land-first is off") });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: "land-first is off: a fast green is not a full-suite result" });
	});

	test("released admission keeps strict off-mode, live-owner, unfinished-work and pending-test guards", () => {
		const w = world();
		const wl = lane(w, { scope: "fast", close: false });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: "the workload is open" });
		landFirst(w);
		const admitted = ready(landingReady(w.ledger, wl, CTX));
		expect(landingReady(w.ledger, lane(w, { close: false }), CTX)).toMatchObject({ ready: false, reason: "the workload is open" });
		const holder = "lane-resumed";
		expect(w.ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder, leaseMs: 600_000 }).won).toBe(true);
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: expect.stringContaining("held live") });
		expect(boardLanding(w.ledger, admitted)).toMatchObject({ boarded: false, reason: expect.stringContaining("held live") });
		w.ledger.releaseWorkload(wl, { by: holder, holder });
		const sl = w.ledger.addSlice({ by: SURFACE_BY, workloadId: wl, task: "more", doneCondition: "done", inputs: "code" });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: "the workload has open or paused slices" });
		expect(boardLanding(w.ledger, admitted)).toMatchObject({ boarded: false, reason: "the workload has open or paused slices" });
		w.ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: sl, kind: "assumption", body: testRequestedBody({ runId: "tr-pending", pr: 101, sha: G, slice: sl, by: holder }) });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: expect.stringContaining("waits on its test run") });
		expect(boardLanding(w.ledger, admitted)).toMatchObject({ boarded: false, reason: expect.stringContaining("waits on its test run") });
		w.ledger.completeSlice(sl, { by: SURFACE_BY, artifact: "done" });
		expect(landingReady(w.ledger, wl, CTX)).toMatchObject({ ready: false, reason: expect.stringContaining("has no result") });
		expect(boardLanding(w.ledger, admitted)).toMatchObject({ boarded: false, reason: expect.stringContaining("has no result") });
	});

	test("R2: each failing rule is not-ready with its reason", () => {
		const w = world();
		const cases: [string, string, RegExp][] = [
			["throwaway", lane(w, { stakes: "throwaway" }), /^stakes throwaway$/],
			["user-driven", lane(w, { mode: "user-driven" }), /^the workload is user-driven$/],
			["open", lane(w, { close: false }), /^the workload is open$/],
			["no done-because", lane(w, { done: false }), /^no holder done-because$/],
			["no run", lane(w, { verdict: "none" }), /^no full-suite run$/],
			["red", lane(w, { verdict: "red" }), /is red$/],
			["stale", lane(w, { verdict: "stale" }), /is stale$/],
			["no review", lane(w, { review: "none" }), /^no review round on any slice$/],
			["a round with no end", lane(w, { review: "round-only" }), /has no loop end after its last round$/],
			["reopened", lane(w, { review: "reopened" }), /has no loop end after its last round$/],
			["ended stop", lane(w, { review: "stop" }), /ended stop, not pass or accept$/],
			["a lane not its holder ended it", lane(w, { endBy: "lane-stranger" }), /has no loop end after its last round$/],
			["only the plan slice reviewed", lane(w, { planOnly: true }), /^no review round on any slice$/],
			["unserved repo", lane(w, { repo: checkout("https://github.com/thewolff/other.git") }), /^the test runner does not serve thewolff\/other$/],
			["plan never approved", lane(w, { extra: (l, wl) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("large") }) }), /^cancelled/],
		];
		for (const [name, wl, reason] of cases) {
			const l = landingReady(w.ledger, wl, CTX);
			expect({ name, ready: l.ready }).toEqual({ name, ready: false });
			if (!l.ready) expect({ name, reason: l.reason }).toEqual({ name, reason: expect.stringMatching(reason) });
		}
		expect(landingReady(w.ledger, STANDING_WORKLOAD_ID, CTX)).toMatchObject({ ready: false, reason: "the standing workload" });
	});

	test("R2: a receipt before the cutover never boards, nor anything before a cutover exists; a close older than 14 days drops out", () => {
		const early = world(false);
		const before = lane(early);
		expect(landingReady(early.ledger, before, CTX)).toMatchObject({ ready: false, reason: "no train-autoboard cutover yet" });
		early.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainAutoboardBody(early.c.now()) });
		early.c.plusHours(0.01);
		const l = landingReady(early.ledger, before, CTX);
		expect(l.ready ? "" : l.reason).toMatch(/predates the train-autoboard cutover/);
		const after = lane(early);
		expect(landingReady(early.ledger, after, CTX).ready).toBe(true);
		// a lane-written cutover is no cutover
		const forged = world(false);
		forged.ledger.recordEntry({ by: "lane-x", workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainAutoboardBody(forged.c.now()) });
		expect(autoboardCutover(forged.ledger)).toBeNull();
		// the 14-day window
		early.c.at(new Date(Date.parse(early.c.now()) + AUTOBOARD_WINDOW_MS + 60_000).toISOString());
		expect(landingReady(early.ledger, after, CTX)).toMatchObject({ ready: false, reason: "closed more than 14 days ago" });
	});

	test("R2: a merge train and a fix workload never board as a lane PR", () => {
		const w = world();
		const fix = lane(w, { extra: (l, wl) => l.recordEntry({ by: MERGE_TRAIN_BY, workloadId: wl, kind: "assumption", body: trainFixBody({ repo: ORIGIN, pr: 101, train: "wl-train1", trainEntry: "en-abc" }) }) });
		expect(isTrainOrFix(w.ledger.entries(fix), w.ledger.instructions(fix))).toBe(true);
		expect(landingReady(w.ledger, fix, CTX)).toMatchObject({ ready: false, reason: "a merge train or a fix workload" });
	});

	test("R27 (PLAN wl-mvqwn80onq9hq8 D11): a closed, autonomous, green, reviewed production workload is ready and boards the train", () => {
		const w = world();
		const prod = lane(w, {
			stakes: "production", pr: 140,
			extra: (l, wl) => {
				l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("production") });
				l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planApprovedBody("in-approve") });
			},
		});
		const l = ready(landingReady(w.ledger, prod, CTX));
		expect([l.workloadId, l.pr, l.sha, l.repo]).toEqual([prod, 140, G, ORIGIN]);
		const r = boardLanding(w.ledger, l);
		if (!r.boarded) throw new Error(r.reason);
		expect(trainPrs(w.ledger.entries(r.train), w.ledger.instructions(r.train))).toEqual([140]);
		expect(actionable(w.ledger, r.train)).toContain("#140 boarded");
		// the ledger half still refuses what it refused for normal: a plan never approved, a red, no review
		const unapproved = lane(w, { stakes: "production", extra: (x, wl) => x.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("production") }) });
		expect(landingReady(w.ledger, unapproved, CTX)).toMatchObject({ ready: false, reason: expect.stringMatching(/^cancelled/) });
		expect(landingReady(w.ledger, lane(w, { stakes: "production", verdict: "red" }), CTX)).toMatchObject({ ready: false, reason: expect.stringMatching(/is red$/) });
		expect(landingReady(w.ledger, lane(w, { stakes: "production", review: "none" }), CTX)).toMatchObject({ ready: false, reason: "no review round on any slice" });
	});
});

describe("boardLanding (D3): reuse the repository's open train, opening one only when none exists", () => {
	test("R1: with no train, the tick opens one as MERGE_TRAIN_BY and boards PR n in the same write; the board makes it actionable; the next PR boards the same train", () => {
		const w = world();
		const first = ready(landingReady(w.ledger, lane(w, { pr: 117 }), CTX));
		const r = boardLanding(w.ledger, first);
		if (!r.boarded) throw new Error(r.reason);
		expect(r.opened).toBe(true);
		const t = w.ledger.workload(r.train)!;
		expect([t.created_by, t.mode, t.stakes, t.status]).toEqual([MERGE_TRAIN_BY, "autonomous", "normal", "open"]);
		expect(t.brief.split("\n")[0]).toBe("merge train (auto-boarded by the train tick): #117");
		expect(t.brief).toContain(`list --workload ${r.train}`);
		const control = controlEntries(w.ledger.entries(r.train));
		expect(control.map((c) => c.prefix)).toEqual(["repo", "done", "train-board"]);
		expect(control.find((c) => c.prefix === "done")!.rest).toBe(TRAIN_DONE);
		const board = w.ledger.entries(r.train).find((e) => e.id === r.entryId)!;
		expect([board.created_by, board.body]).toEqual([MERGE_TRAIN_BY, trainBoardBody({ pr: 117, workload: first.workloadId, head: G, run: first.run, review: first.review })]);
		expect(trainMembers(w.ledger.entries(r.train), w.ledger.instructions(r.train))).toEqual([{ pr: 117, source: "board", by: r.entryId, entryId: r.entryId, createdAt: board.created_at }]);
		expect(openTrains(w.ledger)).toEqual([r.train]);
		expect(actionable(w.ledger, r.train)).toContain("#117 boarded");
		// a second PR boards the open train, at the live head the tick read
		const second = ready(landingReady(w.ledger, lane(w, { pr: 118 }), CTX));
		const r2 = boardLanding(w.ledger, second, { head: H });
		expect(r2).toMatchObject({ boarded: true, train: r.train, opened: false });
		expect(trainPrs(w.ledger.entries(r.train), w.ledger.instructions(r.train))).toEqual([117, 118]);
		expect(parseTrainBoard(w.ledger.entries(r.train).at(-1)!.body.replace(/^train-board: /, ""))?.head).toBe(H);
		// boarding it again is refused: it is on the open train already
		expect(boardLanding(w.ledger, second)).toEqual({ boarded: false, reason: `#118 is already on open merge train ${r.train}` });
		expect(trainPrsOn(w.ledger, ORIGIN)).toEqual(new Set([117, 118]));
	});

	for (const state of ["pre-cutover", "under-half", "half-usd", "half-wall", "full-usd", "full-wall"] as const) {
		test(`D3: a Jo train at ${state} takes the next PR without opening a replacement`, () => {
			const w = world(state !== "pre-cutover");
			const cmd = interpret(w.ledger, "train 90");
			if (cmd?.kind !== "train") throw new Error("not a train");
			const jo = applyTrain(w.ledger, cmd, w.repo).workloadId;
			w.c.plusHours(0.01);
			if (state === "pre-cutover") w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: trainAutoboardBody(w.c.now()) });
			else {
				w.ledger.recordEntry({ by: SURFACE_BY, workloadId: jo, kind: "assumption", body: ceilingBody({ usd: 10, wallMin: 100 }, "test") });
				const usd = state === "full-usd" ? 10 : state === "half-usd" ? 5 : 4;
				const wallMin = state === "full-wall" ? 100 : state === "half-wall" ? 50 : 49;
				w.ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: jo, kind: "assumption", body: spendBody("lane-t-1", { usd, tokens: 1, wallMin }) });
			}
			w.c.plusHours(0.01);
			const l = ready(landingReady(w.ledger, lane(w, { pr: 101 }), CTX));
			const count = () => w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
			const before = count();
			expect(boardLanding(w.ledger, l)).toMatchObject({ boarded: true, train: jo, opened: false });
			expect(trainMembers(w.ledger.entries(jo), w.ledger.instructions(jo)).map((m) => `${m.pr} ${m.source}`)).toEqual(["90 jo", "101 board"]);
			expect(openTrains(w.ledger)).toEqual([jo]);
			expect(count()).toBe(before);
			const entries = w.ledger.entries(jo);
			expect(boardLanding(w.ledger, l)).toEqual({ boarded: false, reason: `#101 is already on open merge train ${jo}` });
			expect(w.ledger.entries(jo)).toEqual(entries);
			expect(count()).toBe(before);
		});
	}

	// Rewritten for PLAN wl-mvr888nftz0vcl D2/D3 (was "an open train with an effective done-because leaves the PR pending until it
	// closes"): the train is permanent, so a legacy done-because on it holds nothing back and the board appends.
	test("D3 (permanent train): an open train with a standing done-because still takes the next PR; no second train opens", () => {
		const w = world();
		const cmd = interpret(w.ledger, "train 90");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const jo = applyTrain(w.ledger, cmd, w.repo).workloadId;
		expect(w.ledger.claimWorkload(jo, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 600_000 }).won).toBe(true);
		w.ledger.recordEntry({ by: "lane-t-1", workloadId: jo, kind: "assumption", body: "done-because: #90 merged" });
		w.ledger.releaseWorkload(jo, { by: "lane-t-1", holder: "lane-t-1" });
		w.c.plusHours(0.01);
		const count = () => w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
		const before = count();
		const r = boardLanding(w.ledger, ready(landingReady(w.ledger, lane(w), CTX)));
		expect(r).toMatchObject({ boarded: true, train: jo, opened: false });
		expect(trainPrs(w.ledger.entries(jo), w.ledger.instructions(jo))).toEqual([90, 101]);
		expect(openTrains(w.ledger)).toEqual([jo]);
		expect(count()).toBe(before + 1);
	});

	test("D3: a forged or superseded done-because does not block the open train", () => {
		for (const state of ["forged", "superseded"] as const) {
			const w = world();
			const cmd = interpret(w.ledger, "train 90");
			if (cmd?.kind !== "train") throw new Error("not a train");
			const jo = applyTrain(w.ledger, cmd, w.repo).workloadId;
			if (state === "superseded") w.ledger.claimWorkload(jo, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 600_000 });
			w.ledger.recordEntry({ by: "lane-t-1", workloadId: jo, kind: "assumption", body: "done-because: #90 merged" });
			if (state === "superseded") w.ledger.recordEntry({ by: "lane-t-1", workloadId: jo, kind: "assumption", body: "acceptance is no longer met" });
			w.c.plusHours(0.01);
			expect(boardLanding(w.ledger, ready(landingReady(w.ledger, lane(w), CTX)))).toMatchObject({ boarded: true, train: jo, opened: false });
		}
	});

	// Rewritten for PLAN wl-mvr888nftz0vcl D2 (was "historical duplicates keep newest-open selection when the newest is
	// active/held/done"): with a stale second open train, the one train is the oldest (`theTrain`); a stop on it leaves the PR
	// pending, a done-because on it holds nothing back, and the stale one is never written.
	for (const state of ["active", "held", "done"] as const) {
		test(`D2: with a stale second open train the board goes to the oldest, which is ${state}`, () => {
			const w = world();
			const cmd = interpret(w.ledger, "train 90");
			if (cmd?.kind !== "train") throw new Error("not a train");
			const oldest = applyTrain(w.ledger, cmd, w.repo).workloadId;
			w.c.plusHours(0.01);
			const stale = staleTrain(w, 91);
			if (state === "held") {
				const sl = trainSliceId(oldest, 90);
				w.ledger.addSlice({ by: "lane-t-1", workloadId: oldest, id: sl, task: "t", doneCondition: "d", inputs: "i" });
				const q = w.ledger.raiseQuestion({ by: "lane-t-1", workloadId: oldest, sliceId: sl, body: "merge #90?", options: ["merged", "skip", "stop"] });
				w.ledger.answerQuestion(q, { ...JO, answer: "stop" });
			} else if (state === "done") {
				w.ledger.claimWorkload(oldest, { by: LANE_STARTER_BY, holder: "lane-t-1", leaseMs: 600_000 });
				w.ledger.recordEntry({ by: "lane-t-1", workloadId: oldest, kind: "assumption", body: "done-because: #90 merged" });
				w.ledger.releaseWorkload(oldest, { by: "lane-t-1", holder: "lane-t-1" });
			}
			const l = ready(landingReady(w.ledger, lane(w), CTX));
			const before = w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
			const entries = [oldest, stale].map((t) => w.ledger.entries(t));
			const r = boardLanding(w.ledger, l);
			if (state === "held") {
				expect(r).toEqual({ boarded: false, reason: `merge train ${oldest} is held by Jo's stop` });
				expect(w.ledger.entries(oldest)).toEqual(entries[0]!);
			} else {
				expect(r).toMatchObject({ boarded: true, train: oldest, opened: false });
				expect(trainPrs(w.ledger.entries(oldest), w.ledger.instructions(oldest))).toEqual([90, 101]);
			}
			expect(w.ledger.entries(stale)).toEqual(entries[1]!);
			expect(openTrains(w.ledger)).toEqual([oldest, stale]);
			expect(w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n).toBe(before);
		});
	}

	// Rewritten for PLAN wl-mvr888nftz0vcl D2 (was "… ignoring another repository's newer train"): `train 101` on another
	// repository can no longer open a second train, so this keeps only the identity match across checkout spellings; the other
	// repository's refusal is surface/test/train-permanent.test.ts R1.
	test("D3: matching follows repoIdentity across checkouts", () => {
		const w = world();
		const cmd = interpret(w.ledger, "train 90");
		if (cmd?.kind !== "train") throw new Error("not a train");
		const jo = applyTrain(w.ledger, cmd, checkout("git@github.com:THEWOLFF/Product.git")).workloadId;
		w.c.plusHours(0.01);
		const l = ready(landingReady(w.ledger, lane(w), CTX));
		const before = w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
		expect(boardLanding(w.ledger, l)).toMatchObject({ boarded: true, train: jo, opened: false });
		expect(trainPrs(w.ledger.entries(jo), w.ledger.instructions(jo))).toEqual([90, 101]);
		expect(openTrains(w.ledger)).toEqual([jo]);
		expect(w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n).toBe(before);
	});

	test("R2: the train held by Jo's stop takes nothing and opens nothing", () => {
		const w = world();
		const first = boardLanding(w.ledger, ready(landingReady(w.ledger, lane(w, { pr: 117 }), CTX)));
		if (!first.boarded) throw new Error(first.reason);
		const sl = trainSliceId(first.train, 117);
		w.ledger.addSlice({ by: "lane-t-1", workloadId: first.train, id: sl, task: "t", doneCondition: "d", inputs: "i" });
		const q = w.ledger.raiseQuestion({ by: "lane-t-1", workloadId: first.train, sliceId: sl, body: "merge #117?", options: ["merged", "skip", "stop"] });
		w.ledger.answerQuestion(q, { ...JO, answer: "stop" });
		w.c.plusHours(0.01);
		const l = ready(landingReady(w.ledger, lane(w, { pr: 118 }), CTX));
		const before = w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n;
		const entries = w.ledger.entries(first.train);
		for (let retry = 0; retry < 2; retry++) {
			expect(boardLanding(w.ledger, l)).toEqual({ boarded: false, reason: `merge train ${first.train} is held by Jo's stop` });
			expect(w.ledger.db.query<{ n: number }, []>("SELECT count(*) AS n FROM workloads").get()!.n).toBe(before);
			expect(w.ledger.entries(first.train)).toEqual(entries);
			expect(trainPrs(w.ledger.entries(first.train), w.ledger.instructions(first.train))).toEqual([117]);
			expect(openTrains(w.ledger)).toEqual([first.train]);
		}
	});

	// Rewritten for lane decision en-mvznmxcdh0ucsj (was "a PR a train worked (merged or skipped by Jo) never boards again"):
	// on the open train a terminal PR boards its next attempt at a new head, never at the head its last board carried; a closed
	// (legacy) train never refuses; the R16 void-board half is unchanged.
	test("R2 and R16: a PR the open train worked boards attempt 2 at a new head, not at the same head; a board on a train closed without working it is void", () => {
		const w = world();
		for (const outcome of ["merged", "skip"] as const) {
			const pr = outcome === "merged" ? 117 : 118;
			const l = ready(landingReady(w.ledger, lane(w, { pr }), CTX));
			const r = boardLanding(w.ledger, l);
			if (!r.boarded) throw new Error(r.reason);
			const sl = trainSliceId(r.train, pr);
			w.ledger.addSlice({ by: "lane-t-1", workloadId: r.train, id: sl, task: "t", doneCondition: "d", inputs: "i" });
			if (outcome === "merged") w.ledger.completeSlice(sl, { by: "lane-t-1", artifact: "merged by train" });
			else w.ledger.cancelSlice(sl, { by: SURFACE_BY });
			w.c.plusHours(0.01);
			expect(boardLanding(w.ledger, l)).toEqual({
				boarded: false, reason: expect.stringMatching(new RegExp(`^#${pr} at ${G} was already boarded on ${r.train} \\(en-[a-z0-9]+\\) and its attempt 1 ended; a new attempt needs a new head$`)),
			});
			const again = boardLanding(w.ledger, l, { head: H });
			expect(again).toMatchObject({ boarded: true, train: r.train, opened: false });
			expect(trainAttemptFor(w.ledger, r.train, pr)).toEqual({ ok: false, reason: `#${pr} is already on open merge train ${r.train}` });
			expect(trainAttemptsOf(w.ledger, r.train).get(pr)?.attempt).toBe(2);
		}
		// void: a train closed with no PR slice for #119; the PR boards again, on a new train
		const t = openTrains(w.ledger)[0]!;
		for (const s of w.ledger.slices(t)) if (s.state === "open") w.ledger.completeSlice(s.id, { by: "lane-t-1", artifact: "x" });
		w.ledger.closeWorkload(t, { by: SURFACE_BY });
		w.c.plusHours(0.01);
		const l = ready(landingReady(w.ledger, lane(w, { pr: 119 }), CTX));
		const r = boardLanding(w.ledger, l);
		if (!r.boarded) throw new Error(r.reason);
		expect(r.train).not.toBe(t);
		w.ledger.closeWorkload(r.train, { by: SURFACE_BY });
		w.c.plusHours(0.01);
		const again = boardLanding(w.ledger, l);
		expect(again).toMatchObject({ boarded: true, opened: true });
		expect(again.boarded && again.train !== r.train).toBe(true);
	});
});

/** A stale second open train (PLAN wl-mvr888nftz0vcl D2), built from rows as the tick once could: MERGE_TRAIN_BY, `repo:` the served checkout, one board of `pr`. */
function staleTrain(w: World, pr: number): string {
	const t = w.ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "stale train", stakes: "normal", mode: "autonomous" });
	w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: t, kind: "assumption", body: `repo: ${w.repo}` });
	w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: t, kind: "assumption", body: trainBoardBody({ pr, workload: t, head: G, run: null, review: null }) });
	w.c.plusHours(0.01);
	return t;
}

describe("membership through train-board: (D2, R5)", () => {
	test("R5: boundPrs admits a boarded PR through the board the merge train wrote, naming it; a lane-written board is dropped and refused", () => {
		const w = world();
		const t = w.ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "merge train (auto-boarded by the train tick): #117", stakes: "normal", mode: "autonomous" });
		const body = (pr: number) => trainBoardBody({ pr, workload: "wl-lane1", head: G, run: "tr-r1", review: "en-v1" });
		const real = w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: t, kind: "assumption", body: body(117) });
		w.ledger.recordEntry({ by: "lane-t-1", workloadId: t, kind: "assumption", body: body(118) });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: t, kind: "assumption", body: body(119) });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: t, kind: "assumption", body: "train-board: pr 120 workload wl-lane1 head short run none review none" });
		const entries = w.ledger.entries(t);
		expect(boundPrs(entries, w.ledger.instructions(t))).toEqual([{ pr: 117, by: real }]);
		expect(controlEntries(entries).filter((c) => c.prefix === "train-board").map((c) => c.id)).toEqual([real, entries.at(-1)!.id]);
		// lane_record_entry refuses every auto-boarding prefix (surface/extensions/lane-tools.ts refuses a reserved prefix)
		for (const p of ["train-board", "train-board-skip", "train-notice", "train-autoboard"]) expect(reservedPrefix(`${p}: x`)).toBe(p);
		// a fix workload's train-fix: names the board entry and binds the PR through it, only when that entry lists the PR
		const fix = w.ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "fix", stakes: "normal", mode: "autonomous" });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: fix, kind: "assumption", body: trainFixBody({ repo: ORIGIN, pr: 117, train: t, trainEntry: real }) });
		w.ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: fix, kind: "assumption", body: trainFixBody({ repo: ORIGIN, pr: 118, train: t, trainEntry: real }) });
		expect(boundPrs(w.ledger.entries(fix), w.ledger.instructions(fix), w.ledger)).toEqual([{ pr: 117, by: real }]);
	});
});

describe("main's protection read live (D6)", () => {
	const RULES = `repos/${ORIGIN}/rules/branches/main`;
	const rule = (over: Record<string, unknown> = {}, check: Record<string, unknown> = { context: "as2/full-suite" }) => ({
		type: "required_status_checks", ruleset_id: 1, parameters: { strict_required_status_checks_policy: true, required_status_checks: [check], ...over },
	});
	/** gh as `protectionGap` reads it: the rules answer, and ruleset 1's bypass; a thrown value is a failed call. */
	const gh = (rules: unknown, bypass: unknown = "never") => (args: string[]): unknown => {
		if (args[1] === RULES) {
			if (rules instanceof Error) throw rules;
			return rules;
		}
		if (args[1] === `repos/${ORIGIN}/rulesets/1`) {
			if (bypass instanceof Error) throw bypass;
			return { id: 1, current_user_can_bypass: bypass };
		}
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};

	test("R9: a strict, app-free as2/full-suite rule in a ruleset the merging account can never bypass is ok; each missing piece is a gap naming it", () => {
		expect(protectionGap(ORIGIN, gh([rule()]))).toEqual({ state: "ok" });
		expect(protectionGap(ORIGIN, gh([]))).toEqual({ state: "gap", text: "no active rule on main requires status checks" });
		expect(protectionGap(ORIGIN, gh([rule({}, { context: "ci" })]))).toEqual({ state: "gap", text: "no required status check on main names as2/full-suite" });
		expect(protectionGap(ORIGIN, gh([rule({}, { context: "as2/full-suite", integration_id: 15368 })])).state).toBe("gap");
		expect(protectionGap(ORIGIN, gh([rule({ strict_required_status_checks_policy: false })]))).toEqual({
			state: "gap", text: "the rule requiring as2/full-suite on main is not strict (a branch need not be up to date)",
		});
		expect(protectionGap(ORIGIN, gh([rule()], "always"))).toEqual({ state: "gap", text: "merging account can bypass ruleset 1 (always)" });
	});

	test("R9: a failed rules or ruleset read is unknown, never a gap", () => {
		expect(protectionGap(ORIGIN, gh(new Error("gh api exited 1: HTTP 502")))).toEqual({ state: "unknown", text: "gh api exited 1: HTTP 502" });
		expect(protectionGap(ORIGIN, gh({ message: "Not Found" }))).toEqual({ state: "unknown", text: "the rules read is not a list" });
		expect(protectionGap(ORIGIN, gh([rule()], new Error("HTTP 403")))).toEqual({ state: "unknown", text: "ruleset 1 could not be read: HTTP 403" });
	});

	test("R9: a ruleset answer with no usable current_user_can_bypass is unknown, never a gap (review wl-mvbjiettjrfpxc r1 #3)", () => {
		/** gh answering ruleset 1 with `answer` whole, over a qualifying rule. */
		const read = (answer: unknown) => (args: string[]): unknown => (args[1] === `repos/${ORIGIN}/rulesets/1` ? answer : gh([rule()])(args));
		const unusable: [unknown, string][] = [
			[null, "none"], [{ message: "Not Found" }, "none"], [{ id: 1 }, "none"], [{ id: 1, current_user_can_bypass: null }, "null"],
			[{ id: 1, current_user_can_bypass: 1 }, "1"], [{ id: 1, current_user_can_bypass: "sometimes" }, `"sometimes"`],
		];
		for (const [answer, shown] of unusable) {
			expect(protectionGap(ORIGIN, read(answer))).toEqual({ state: "unknown", text: `ruleset 1 gave no usable current_user_can_bypass (${shown})` });
		}
		expect(protectionGap(ORIGIN, gh([rule()], "exempt"))).toEqual({ state: "gap", text: "merging account can bypass ruleset 1 (exempt)" });
	});
});
