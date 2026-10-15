// The runner's ceiling meter (DESIGN-workload-ceiling.md § 2 item 4, § 6) without spawning anything:
// the pure step over the 80 / 100 thresholds and the ceiling question's state, and the ledger side
// of a raise (slice, question with its link header, question-links: and spend: in one write), of the question's state per ceiling value,
// of the withdrawal at a clean finish, and of a relaunch that keeps the cumulative total, on a temp ledger.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_RUNNER_BY, Ledger } from "../../ledger/src/index";
import { type Ceiling, CEILING_OPTIONS, ceilingBody, ceilingQuestionBody, parseSpend, scanSpend, type Spend, wallMinutes } from "../src/ceiling";
import { recordRepo } from "../src/decision-log";
import { apply } from "../src/input";
import { controlEntries, doneBody, laneDir, laneExit, laneExitBody, laneStartedBody } from "../src/launch";
import { expectedLinks, questionLinks } from "../src/question-links";
import { SURFACE_BY } from "../src/types";
import { ceilingKey, ceilingQuestionState, type CeilingQuestionState, type MeterState, meterStep, raiseCeilingQuestion, withdrawCeilingQuestions } from "../scripts/lane";
import { alive, clock, fakeRecords, git, LANE_SCRIPT, laneIdOf, laneRoot, laneSnapshot, settleDrains, setScript, sh, tempLedger, tmp, until, workloadWithSlice } from "./helpers";

const NORMAL: Ceiling = { usd: 50, wallMin: 360 };
const EXTENDED: Ceiling = { usd: 100, wallMin: 720 };
const spent = (usd: number, wallMin = 0): Spend => ({ usd, tokens: 1000, wallMin });
const fresh: MeterState = { raised: [] };
const step = (state: MeterState, ceiling: Ceiling, spend: Spend, question: CeilingQuestionState, raisePending = false) => meterStep(state, { ceiling, spend, question, raisePending });

describe("meterStep: the step matrix", () => {
	test("below 80 % of both halves: nothing", () => {
		expect(step(fresh, NORMAL, spent(39.99, 287), "none")).toEqual({ state: fresh, level: 0, raise: false, stop: false });
	});

	test("exactly 80 % raises once and the lane keeps working; a second poll at 85 % does not raise again, from the ledger's open question or from the runner's own memory", () => {
		const first = step(fresh, NORMAL, spent(40), "none");
		expect(first).toMatchObject({ level: 80, raise: true, stop: false });
		expect(first.state.raised).toEqual([ceilingKey(NORMAL)]);
		expect(step(first.state, NORMAL, spent(42.5), "open")).toMatchObject({ level: 80, raise: false, stop: false });
		// the raise this runner wrote is not in the rows it read (or they were read before the write): memory holds
		expect(step(first.state, NORMAL, spent(42.5), "none")).toMatchObject({ raise: false, stop: false });
		// a relaunched runner has no memory; the ledger's question is enough
		expect(step(fresh, NORMAL, spent(42.5), "open")).toMatchObject({ raise: false, stop: false });
	});

	test("the wall half alone crosses 80 % and 100 %", () => {
		expect(step(fresh, NORMAL, spent(1, 288), "none")).toMatchObject({ level: 80, raise: true, stop: false });
		expect(step(fresh, NORMAL, spent(1, 360), "open")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % with the question open stops, without a second question", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, NORMAL, spent(50), "open")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % answered stop or split stops, without a second question", () => {
		for (const q of ["stop", "split"] as const) expect(step(fresh, NORMAL, spent(51), q)).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("100 % with no question open or answered for the value raises with the stop, even when this run raised it at 80 % and Jo withdrew it", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		// Jo withdrew it at 85 %: this run does not ask again before 100 %
		expect(step(raised, NORMAL, spent(42.5), "none")).toMatchObject({ level: 80, raise: false, stop: false });
		const stopped = step(raised, NORMAL, spent(50), "none");
		expect(stopped).toMatchObject({ level: 100, raise: true, stop: true });
		expect(stopped.state.raised).toEqual([ceilingKey(NORMAL)]);
	});

	test("answered extend: the raised ceiling is the new value, so the lane at the old 100 % continues; an extend whose raise has not landed still stops at the old value", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, EXTENDED, spent(50, 100), "none")).toMatchObject({ level: 0, raise: false, stop: false });
		expect(step(raised, NORMAL, spent(50), "extend")).toMatchObject({ level: 100, raise: false, stop: true });
	});

	test("a jump from 50 % to 100 % between polls stops, and raises the question with the stop so Jo has the answers", () => {
		expect(step(fresh, NORMAL, spent(25), "none")).toMatchObject({ level: 0, raise: false, stop: false });
		const jumped = step(fresh, NORMAL, spent(50), "none");
		expect(jumped).toMatchObject({ level: 100, raise: true, stop: true });
		expect(jumped.state.raised).toEqual([ceilingKey(NORMAL)]);
	});

	test("a new ceiling after extend raises again at its own 80 %, once", () => {
		const raised = step(fresh, NORMAL, spent(40), "none").state;
		expect(step(raised, EXTENDED, spent(79.99), "none")).toMatchObject({ raise: false, stop: false });
		const again = step(raised, EXTENDED, spent(80), "none");
		expect(again).toMatchObject({ level: 80, raise: true, stop: false });
		expect(again.state.raised).toEqual([ceilingKey(NORMAL), ceilingKey(EXTENDED)]);
		expect(step(again.state, EXTENDED, spent(90), "none")).toMatchObject({ raise: false, stop: false });
	});

	test("a pending raise for the old ceiling leaves the extended ceiling eligible at 80 % and at the stop boundary", () => {
		const first = step(fresh, NORMAL, spent(40), "none");
		expect(first).toMatchObject({ raise: true, stop: false });
		expect(first.state.raised).toEqual([ceilingKey(NORMAL)]);
		const skipped = step(first.state, EXTENDED, spent(80), "none", true);
		expect(skipped).toMatchObject({ level: 80, raise: false, stop: false });
		expect(skipped.state).toBe(first.state);
		const raised = step(skipped.state, EXTENDED, spent(80), "none");
		expect(raised).toMatchObject({ level: 80, raise: true, stop: false });
		expect(raised.state.raised).toEqual([ceilingKey(NORMAL), ceilingKey(EXTENDED)]);
		expect(step(raised.state, EXTENDED, spent(90), "none")).toMatchObject({ raise: false, stop: false });
		const atStop = step(first.state, EXTENDED, spent(100), "none", true);
		expect(atStop).toMatchObject({ level: 100, raise: false, stop: true });
		expect(atStop.state).toBe(first.state);
		expect(step(atStop.state, EXTENDED, spent(100), "none")).toMatchObject({ raise: true, stop: true });
	});
});

describe("the ledger side of the meter", () => {
	test("a raise is one write stamped lane-runner: the ceiling slice (paused by its question), the question with its link header and stop / extend / split, its question-links:, the spend: entry", async () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const laneId = `lane-${wl.slice(3)}-1`;
		const spend: Spend = { usd: 40.5, tokens: 123456, wallMin: 12.34 };
		const { sliceId, questionId } = await raiseCeilingQuestion(ledger, { workloadId: wl, laneId, spend, ceiling: NORMAL, stakes: "normal" });
		expect(sliceId).toBe(`sl-ceiling-${wl.slice(3)}-1`);
		const slice = ledger.slice(sliceId)!;
		expect(slice).toMatchObject({ workload_id: wl, task: "Jo decides the ceiling overrun", inputs: "ceiling", state: "paused", created_by: LANE_RUNNER_BY });
		const q = ledger.question(questionId)!;
		// No repo: entry, so no PR to read; nothing reviewed and not plan-first: the header is the two fixed `none` lines.
		const links = expectedLinks(ledger, { workloadId: wl, sliceId: null, prs: { ok: true, prs: [] } });
		expect(q).toMatchObject({ slice_id: sliceId, state: "open", created_by: LANE_RUNNER_BY, body: ceilingQuestionBody(wl, spend, NORMAL, "normal", links) });
		expect(q.body.split("\n").slice(0, 2)).toEqual([`plan: none — ${wl} is not plan-first: it has no plan slice`, `review: none — no review round has completed on ${wl}`]);
		expect(ledger.entries(wl).filter((e) => e.body.startsWith(`question-links: ${questionId} `)).map((e) => [e.created_by, e.created_at])).toEqual([[LANE_RUNNER_BY, q.created_at]]);
		expect(JSON.parse(q.options)).toEqual([...CEILING_OPTIONS]);
		const spends = controlEntries(ledger.entries(wl)).filter((e) => e.prefix === "spend");
		expect(spends).toHaveLength(1);
		expect(spends[0]).toMatchObject({ laneId, createdBy: LANE_RUNNER_BY });
		expect(parseSpend(spends[0]!.rest)).toEqual({ usd: 40.5, tokens: 123456, wallMin: 12.3 });
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL)).toBe("open");
		// a second ceiling question on the workload gets the next id
		expect((await raiseCeilingQuestion(ledger, { workloadId: wl, laneId, spend, ceiling: EXTENDED, stakes: "normal" })).sliceId).toBe(`sl-ceiling-${wl.slice(3)}-2`);
	});

	test("a raise whose spend: write fails leaves neither the slice nor the question nor its links", async () => {
		const { ledger, path } = tempLedger();
		const { wl } = workloadWithSlice(ledger);
		const db = new Database(path);
		db.exec("CREATE TRIGGER fail_spend BEFORE INSERT ON entries WHEN NEW.body LIKE 'spend:%' BEGIN SELECT RAISE(ABORT, 'injected spend failure'); END;");
		db.close();
		await expect(raiseCeilingQuestion(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, spend: spent(40), ceiling: NORMAL, stakes: "normal" })).rejects.toThrow(/injected spend failure/);
		expect(ledger.slices(wl).filter((s) => s.id.startsWith("sl-ceiling-"))).toEqual([]);
		expect(ledger.questions(wl)).toEqual([]);
		expect(ledger.entries(wl).some((e) => e.body.startsWith("question-links:"))).toBe(false);
	});

	test("the question's state is per ceiling value: another value reads none; Jo's answer reads as its option; a lane's own sl-ceiling- slice is not the runner's", async () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const lane = ledger.addSlice({ by: "lane-a", workloadId: wl, id: `sl-ceiling-plan-${wl.slice(3)}`, task: "plan the ceiling", doneCondition: `the ceiling ${ceilingKey(NORMAL)}`, inputs: "x" });
		ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: lane, body: "approve?", options: ["approve", "revise"] });
		const state = () => ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(state()).toBe("none");
		c.plusHours(1);
		const { questionId } = await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: "lane-x-1", spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		expect(state()).toBe("open");
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), EXTENDED)).toBe("none");
		c.plusHours(1);
		ledger.answerQuestion(questionId, { by: SURFACE_BY, answer: "extend", author: "jo", channel: "surface" });
		expect(state()).toBe("extend");
	});

	test("a clean finish withdraws the open ceiling question (then cancel: the slice is cancelled), and nothing else; the value then reads as never asked", async () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const own = ledger.addSlice({ by: "lane-a", workloadId: wl, id: `sl-ceiling-own-${wl.slice(3)}`, task: "t", doneCondition: "d", inputs: "i" });
		const ownQ = ledger.raiseQuestion({ by: "lane-a", workloadId: wl, sliceId: own, body: "b", options: ["a", "b"] });
		c.plusHours(1);
		const { sliceId, questionId } = await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: "lane-x-1", spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		c.plusHours(1);
		expect(withdrawCeilingQuestions(ledger, wl)).toEqual([questionId]);
		expect(ledger.question(questionId)!.state).toBe("withdrawn");
		const withdrawal = ledger.instructions(wl).find((i) => i.id === ledger.question(questionId)!.resolved_by)!;
		expect(withdrawal).toMatchObject({ kind: "withdrawal", disposition: "cancel", author: LANE_RUNNER_BY, channel: "direct", created_by: LANE_RUNNER_BY, body: "finished under the ceiling" });
		expect(ledger.slice(sliceId)!.state).toBe("cancelled");
		expect(ledger.question(ownQ)!.state).toBe("open");
		expect(withdrawCeilingQuestions(ledger, wl)).toEqual([]);
		expect(ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL)).toBe("none");
	});
});

describe("a relaunch on the same ceiling (§ 2 items 3, 4)", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});
	const assistant = (cost: number) => `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1000, cost: { total: cost } } } })}\n`;
	const started = (laneId: string) => laneStartedBody(laneId, { pid: 1, start: "x", session: null, argv: [], runnerPid: 2 });

	test("keeps the cumulative total: a fresh runner's scan counts every run's session files, its wall counts the earlier run, and 85 % raises afresh after the clean finish withdrew the first question", async () => {
		const c = clock("2026-10-01T10:00:00.000Z");
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		const record = (body: string) => ledger.recordEntry({ by: LANE_RUNNER_BY, workloadId: wl, kind: "assumption", body });
		const control = () => controlEntries(ledger.entries(wl));
		const dir = tmp("ceiling-relaunch");
		roots.push(dir);
		const laneFile = join(dir, "2026_lane.jsonl");

		// Run 1: an hour, $30 on the lane and $10 on a hand; 80 % raises, then the clean finish withdraws it.
		const lane1 = `lane-${wl.slice(3)}-1`;
		record(started(lane1));
		const start1 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(30));
		mkdirSync(join(dir, "2026_lane"));
		writeFileSync(join(dir, "2026_lane", "0-Hand.jsonl"), assistant(10));
		c.at("2026-10-01T11:00:00.000Z");
		const run1: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start1) };
		expect(run1).toEqual({ usd: 40, tokens: 2000, wallMin: 60 });
		const first = step(fresh, NORMAL, run1, ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL));
		expect(first).toMatchObject({ level: 80, raise: true, stop: false });
		await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: lane1, spend: run1, ceiling: NORMAL, stakes: "normal" });
		expect(withdrawCeilingQuestions(ledger, wl)).toHaveLength(1);
		record(laneExitBody(lane1, { code: 0, signal: null, outcome: "completed" }));

		// Parked on Jo for two hours, then run 2 resumes the lane session (--resume appends to the same file) with a fresh runner.
		c.at("2026-10-01T13:00:00.000Z");
		const lane2 = `lane-${wl.slice(3)}-2`;
		record(started(lane2));
		const start2 = Date.parse(c.now());
		writeFileSync(laneFile, assistant(2.5), { flag: "a" });
		c.at("2026-10-01T13:30:00.000Z");
		const run2: Spend = { ...scanSpend(dir, new Map(), { usd: 0, tokens: 0, wallMin: 0 }), wallMin: wallMinutes(control(), Date.parse(c.now()), start2) };
		expect(run2).toEqual({ usd: 42.5, tokens: 3000, wallMin: 90 });
		const state = () => ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(state()).toBe("none");
		expect(step({ raised: [] }, NORMAL, run2, state())).toMatchObject({ level: 80, raise: true, stop: false });
		await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: lane2, spend: run2, ceiling: NORMAL, stakes: "normal" });
		expect(state()).toBe("open");
		expect(ledger.questions(wl).filter((q) => q.state === "open")).toHaveLength(1);
	});

	test("a relaunch that jumps straight past 100 % after a withdrawn question raises with the stop, so the stop leaves Jo an open question", async () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl } = workloadWithSlice(ledger);
		await raiseCeilingQuestion(ledger, { workloadId: wl, laneId: `lane-${wl.slice(3)}-1`, spend: spent(40), ceiling: NORMAL, stakes: "normal" });
		withdrawCeilingQuestions(ledger, wl);
		const state = ceilingQuestionState(ledger.questions(wl), ledger.slices(wl), ledger.instructions(wl), NORMAL);
		expect(step(fresh, NORMAL, spent(55), state)).toMatchObject({ level: 100, raise: true, stop: true });
	});
});

describe("the real runner's deferred ceiling question", () => {
	test("an 80 % PR read still pending at a new ceiling's 100 % stop settles before exit, then raises the new value with its own links", async () => {
		const root = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "ceiling-runner-"));
		const r = laneRoot({}, root);
		const oldReadStarted = join(root, "old-pr-read-started");
		const releaseOldRead = join(root, "release-old-pr-read");
		const armedRead = join(root, "arm-pr-read");
		const ghCalls = join(root, "gh-calls");
		r.env.FAKE_GH_STARTED = oldReadStarted;
		r.env.FAKE_GH_GATE = releaseOldRead;
		r.env.FAKE_GH_ARM = armedRead;
		r.env.FAKE_GH_CALLS = ghCalls;
		const gh = join(root, "bin", "gh");
		writeFileSync(gh, `#!/bin/sh
stage=startup
if [ -e "$FAKE_GH_ARM" ]; then stage=ceiling; fi
printf '%s %s\\n' "$stage" "$*" >> "$FAKE_GH_CALLS"
if [ "$*" != "$FAKE_GH_ARGS" ]; then
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 2
fi
# A startup invocation stays ungated even if the test arms while this invocation runs.
if [ "$stage" = startup ]; then
  printf '[]\\n'
  exit 0
fi
if [ -e "$FAKE_GH_STARTED" ]; then
  printf '[{"number":18,"url":"https://github.com/acme/widgets/pull/18"}]\\n'
  exit 0
fi
: > "$FAKE_GH_STARTED"
i=0
while [ ! -e "$FAKE_GH_GATE" ]; do
  i=$((i + 1))
  if [ "$i" -ge 500 ]; then
    printf 'timed out waiting for the old PR read gate\\n' >&2
    exit 124
  fi
  sleep 0.05
done
printf '[{"number":17,"url":"https://github.com/acme/widgets/pull/17"}]\\n'
`);
		chmodSync(gh, 0o755);
		let runnerPid = 0;
		let finished = false;
		let wl = "";
		let failure: Error | null = null;
		try {
			const l = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
			try {
				wl = l.openWorkload({ by: SURFACE_BY, brief: "ceiling runner deferred PR read", stakes: "normal", mode: "autonomous" });
				recordRepo(l, wl, r.repo);
				r.env.FAKE_GH_ARGS = `pr list --repo acme/widgets --head wl/${wl} --state open --json number,url`;
				l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: doneBody("the probe is done") });
				l.addSlice({ by: SURFACE_BY, workloadId: wl, task: "stay open until the ceiling stop", doneCondition: "the runner stops", inputs: "README.md" });
				l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: ceilingBody({ usd: 1, wallMin: 60 }, "test tiny ceiling") });
			} finally {
				l.close();
			}
			setScript(r, { steps: [{ hang: true }] });
			const launch = sh(["bun", LANE_SCRIPT, "launch", wl, "--requested-by", "test"], r.repo, r.env);
			expect(launch.code).toBe(0);
			runnerPid = Number(/^lane \S+ runner (\d+)$/.exec(launch.out)?.[1] ?? 0);
			expect(runnerPid).toBeGreaterThan(0);
			const laneId = laneIdOf(wl, 1);
			await until("runner ready for first prompt", () => laneSnapshot(r, wl).control.some((c) => c.prefix === "lane-ready" && c.laneId === laneId));
			const session = await until("fake OMP session", () => fakeRecords(r).find((x) => x.session)?.session);
			// The starter fetched the local bare origin; arm only the PR read after the runner is ready.
			expect(git(r.repo, ["config", "remote.origin.url", "git@github.com:acme/widgets.git"]).code).toBe(0);
			writeFileSync(armedRead, "arm\n");
			appendFileSync(session, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 850, cost: { total: 0.85 } } } })}\n`);
			await until("old-value gh PR read started", () => existsSync(oldReadStarted));
			expect(laneSnapshot(r, wl).questions).toHaveLength(0);

			// The old PR read remains blocked. Jo raises the effective ceiling, then new usage reaches its 100 %.
			const changing = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
			try {
				expect(apply(changing, { kind: "ceiling", workloadId: wl, usd: 2, wallMin: 60 })).toContain(`ceiling on ${wl} → $2`);
			} finally {
				changing.close();
			}
			appendFileSync(session, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { totalTokens: 1150, cost: { total: 1.15 } } } })}\n`);
			await until("runner accepts the new ceiling's stop while the old PR read is blocked", () =>
				laneSnapshot(r, wl).control.find((c) => c.prefix === "lane-stop" && c.laneId === laneId && c.rest === "accepted ceiling"));
			const stopped = laneSnapshot(r, wl);
			expect(stopped.questions).toHaveLength(0);
			expect(laneExit(stopped.control, laneId)).toBeNull();

			// A missing await on the old read exits without a question; a missing re-meter only raises the old one.
			writeFileSync(releaseOldRead, "release\n");
			const exit = await until("lane exit after both PR reads and questions", () => laneExit(laneSnapshot(r, wl).control, laneId));
			expect(exit).toMatchObject({ outcome: "stop", reason: "ceiling" });
			const final = laneSnapshot(r, wl);
			expect(final.deaths).toEqual([]);
			const questions = final.questions.filter((q) => q.created_by === LANE_RUNNER_BY && q.slice_id.startsWith("sl-ceiling-"));
			expect(questions).toHaveLength(2);
			expect(questions.map((q) => q.state)).toEqual(["open", "open"]);
			expect(questions.filter((q) => q.body.includes("$0.85 of its $1 ceiling (85 %)"))).toHaveLength(1);
			const oldQuestion = questions.find((q) => q.body.includes("$0.85 of its $1 ceiling (85 %)"))!;
			expect(oldQuestion.body).toContain("pr: https://github.com/acme/widgets/pull/17");
			expect(oldQuestion.body).not.toContain("pr: https://github.com/acme/widgets/pull/18");
			const newQuestions = questions.filter((q) => q.body.includes("of its $2 ceiling"));
			expect(newQuestions).toHaveLength(1);
			const newQuestion = newQuestions[0]!;
			expect(newQuestion.body).toContain("$2.00 of its $2 ceiling (100 %)");
			expect(newQuestion.body.split("\n").slice(0, 4)).toEqual([
				`plan: none — ${wl} is not plan-first: it has no plan slice`,
				`review: none — no review round has completed on ${wl}`,
				"pr: https://github.com/acme/widgets/pull/17",
				"pr: https://github.com/acme/widgets/pull/18",
			]);
			expect(JSON.parse(newQuestion.options)).toEqual([...CEILING_OPTIONS]);
			const linked = Ledger.open(r.ledgerPath, { backup: false, backupOnOpen: false });
			try {
				expect(questionLinks(linked, wl, newQuestion.id)?.links.prs).toEqual({
					prs: [
						{ number: 17, url: "https://github.com/acme/widgets/pull/17" },
						{ number: 18, url: "https://github.com/acme/widgets/pull/18" },
					],
					unverified: null,
				});
			} finally {
				linked.close();
			}
			expect(readFileSync(ghCalls, "utf8").trim().split("\n").filter((call) => call.startsWith("ceiling "))).toEqual([
				`ceiling ${r.env.FAKE_GH_ARGS}`,
				`ceiling ${r.env.FAKE_GH_ARGS}`,
			]);
			finished = true;
		} catch (err) {
			const log = wl ? join(laneDir(wl, r.home), "runner.log") : null;
			failure = new Error([
				String(err),
				`runner pid: ${runnerPid}`,
				`runner log:\n${log && existsSync(log) ? readFileSync(log, "utf8") : "(not written)"}`,
				`fake OMP records:\n${existsSync(r.record) ? readFileSync(r.record, "utf8") : "(not written)"}`,
				`gh calls:\n${existsSync(ghCalls) ? readFileSync(ghCalls, "utf8") : "(not written)"}`,
				`ledger:\n${wl ? JSON.stringify(laneSnapshot(r, wl)) : "(workload not opened)"}`,
			].join("\n"), { cause: err });
		} finally {
			writeFileSync(releaseOldRead, "release\n");
			try {
				if (!finished && runnerPid > 0 && alive(runnerPid)) {
					process.kill(runnerPid, "SIGTERM");
					try {
						await until("failed runner gone after SIGTERM", () => !alive(runnerPid), 4_000);
					} catch {
						if (alive(runnerPid)) process.kill(runnerPid, "SIGKILL");
						await until("failed runner gone after SIGKILL", () => !alive(runnerPid), 4_000);
					}
				}
				await settleDrains(r, 30_000);
			} catch (err) {
				if (failure) failure.message += `\ncleanup failed: ${String(err)}`;
				else failure = new Error(`cleanup failed: ${String(err)}`, { cause: err });
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
		if (failure) throw failure;
	}, 100_000);
});
