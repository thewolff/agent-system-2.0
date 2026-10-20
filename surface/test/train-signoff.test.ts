// Jo's train word on a production-stakes PR is his merge sign-off (jo-issues #155; PLAN wl-mvg8itbt0rz3ls D1, D2; R1-R3, R10):
// the real `lane_raise_question` on a merge train's merged / skip / stop question, on a scratch ledger with a fake gh behind
// pi.exec. Decided by Jo's ruling train-signoff (no question row, the lane's `ruling-applied:`) only when Jo's `train` word names
// the PR, its `wl/` workload is production with its review settled and passed, a green is at its current head and main's
// protection reads ok live; raised as before for every failing rule, for any gh read failing, and after Jo's
// `end-ruling train-signoff`. The cases import only names the pre-change tree has, so on it every decided case fails.
import { describe, expect, test } from "bun:test";
import { reviewLoopEndBody, reviewRoundBody, UNKNOWN, type LoopEndReason } from "../../classifier/src/rounds";
import { CLASSIFIER_BY, LANE_STARTER_BY, type Ledger, TEST_RUNNER_BY } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { recordRepo } from "../src/decision-log";
import { ensureStandingWorkload } from "../src/identity";
import { apply, applyTrain, interpret } from "../src/input";
import { JO_HOLDER, planAutoApprovedBody, planAutoStartNoticeBody, planFirstBody, trainBoardBody } from "../src/launch";
import { reviewSettledPassed, trainBody, trainFullSliceId, trainInstructionBody, trainSliceId } from "../src/merge-train";
import { sendNotice } from "../src/notice";
import { makeRunId, testRequestedBody, testRunBody, type TestVerdict } from "../src/test-run";
import { ESCALATION_BY, HOLD_HOURS, LANE_RAISE_QUESTION_TOOL, MERGE_TRAIN_BY, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const REPO = "thewolff/product";
const URL = `https://github.com/${REPO}.git`;
const TRAIN_LANE = "lane-train-1";
const OWNER_LANE = "lane-owner-1";
const PR = 101;
const H0 = "a".repeat(40);
const H1 = "b".repeat(40);
const OPTIONS = ["merged", "skip", "stop"];
const RULESET = 7;

/** A git checkout at a temp path whose origin is `url`, the `repo:` a workload is on. */
function checkout(url = URL): string {
	const dir = tmp("train-signoff-repo");
	for (const args of [["init", "-q"], ["config", "remote.origin.url", url]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	}
	return dir;
}

/** gh's answers: the PR view, main's rules and the ruleset; each a JSON value, or `fail` for a gh exit 1. */
interface Gh {
	view: unknown;
	rules: unknown;
	ruleset: unknown;
}
const FAIL = Symbol("gh fails");
type Answer = unknown | typeof FAIL;

/** What a test drives: the ledger, the train and W with their slices, writers of runs and reviews, gh's answers and the ask. */
interface World {
	ledger: Ledger;
	train: string;
	owner: string;
	sl: string;
	full: string;
	work: string;
	ownerFull: string;
	run: (wl: string, slice: string, sha: string, verdict: TestVerdict) => string;
	reviewed: (token: string) => void;
	loopEnd: (reason: LoopEndReason) => void;
	answers: Record<keyof Gh, Answer>;
	/** `duringGh` runs inside the fake gh's `pr view`, before its answer reaches the tool: after the tool's guards, before its write. `on` is the slice asked on (the PR's disposition slice by default). */
	ask: (options?: string[], duringGh?: () => void, on?: string) => Promise<{ text: string; calls: { command: string; args: string[] }[] }>;
	applied: () => (string | null)[][];
}

/**
 * The world: W (branch `wl/<W>`, production, on a checkout of REPO, held by OWNER_LANE) and a train on REPO held by TRAIN_LANE
 * (`source` jo: opened by Jo's `train 101`; board: opened by the tick's `train-board:` alone). Defaults make the decided case.
 */
function world(o: { source?: "jo" | "board"; stakes?: "normal" | "production"; now?: () => string } = {}): World {
	const { ledger, path } = tempLedger(o.now);
	const owner = ledger.openWorkload({ by: SURFACE_BY, brief: "Fix the feed header", stakes: o.stakes ?? "production", mode: "autonomous" });
	recordRepo(ledger, owner, checkout());
	expect(ledger.claimWorkload(owner, { by: LANE_STARTER_BY, holder: OWNER_LANE, leaseMs: 600_000 }).won).toBe(true);
	const branch = `wl/${owner}`;
	let train: string;
	if ((o.source ?? "jo") === "jo") {
		const cmd = interpret(ledger, `train ${PR}`);
		if (cmd?.kind !== "train") throw new Error("not a train");
		train = applyTrain(ledger, cmd, checkout()).workloadId;
	} else {
		train = ledger.openWorkload({ by: MERGE_TRAIN_BY, brief: "merge train (auto-boarded by the train tick)", stakes: "normal", mode: "autonomous" });
		recordRepo(ledger, train, checkout());
		ledger.recordEntry({ by: MERGE_TRAIN_BY, workloadId: train, kind: "assumption", body: trainBoardBody({ pr: PR, workload: owner, head: H1, run: null, review: null }) });
	}
	expect(ledger.claimWorkload(train, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: 600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: TRAIN_LANE, workloadId: train, id: trainSliceId(train, PR), task: `#${PR} on the train`, doneCondition: "terminal", inputs: `PR #${PR}` });
	const full = ledger.addSlice({ by: TRAIN_LANE, workloadId: train, id: trainFullSliceId(train, PR, 1), task: `#${PR} suite`, doneCondition: "green", inputs: `PR #${PR}` });
	const work = ledger.addSlice({ by: OWNER_LANE, workloadId: owner, task: "move the header", doneCondition: "moved", inputs: "the header" });
	const ownerFull = ledger.addSlice({ by: OWNER_LANE, workloadId: owner, task: "suite", doneCondition: "green", inputs: `PR #${PR}` });

	let seq = 0;
	/** A runner request and its result on `wl`'s `slice` for PR 101 at `sha`. */
	const run = (wl: string, slice: string, sha: string, verdict: TestVerdict) => {
		const runId = makeRunId(Date.now() + ++seq, "abcd");
		ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption", body: testRequestedBody({ runId, pr: PR, sha, slice, by: TRAIN_LANE }) });
		const red = verdict === "red";
		ledger.recordEntry({
			by: TEST_RUNNER_BY, workloadId: wl, sliceId: slice, kind: "assumption",
			body: testRunBody({
				runId, verdict, sha, pr: PR, reason: null, headAtEnd: sha, base: null, mergeBase: null,
				full: { pass: 1, fail: red ? 1 : 0, skip: 0, exit: red ? 1 : 0, ms: 10, error: null }, solo: [],
				failures: red ? [{ part: "full", name: "src/x.test.ts > case 1", firstError: "boom" }] : [], runDir: null, preflight: null,
			}),
		});
		return runId;
	};
	/** One review hand on W's slice: its dispatch (`hand-spawn: … review yes`) and the classifier's `review-round:`. */
	const reviewed = (token: string) => {
		ledger.recordEntry({ by: OWNER_LANE, workloadId: owner, sliceId: work, kind: "assumption", body: `hand-spawn: ${token} session /sessions/${token} spawn - review yes group dg-${token} row openai-codex/gpt-6.1-sol` });
		ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: owner, sliceId: work, kind: "assumption", body: reviewRoundBody({ slice: work, round: 1, token, group: `dg-${token}`, verdict: "accepted", findings: UNKNOWN }) });
	};
	const loopEnd = (reason: LoopEndReason) => ledger.recordEntry({ by: OWNER_LANE, workloadId: owner, sliceId: work, kind: "assumption", body: reviewLoopEndBody(work, reason) });

	const gh: Gh = {
		view: { number: PR, headRefName: branch, headRefOid: H1, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } },
		rules: [{ type: "required_status_checks", ruleset_id: RULESET, parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "as2/full-suite" }] } }],
		ruleset: { id: RULESET, enforcement: "active", current_user_can_bypass: "never" },
	};
	const answers: Record<keyof Gh, Answer> = { ...gh };

	/** Ask the merge question through the real tool, as TRAIN_LANE; the reply text and the gh calls it made. */
	const ask = async (options = OPTIONS, duringGh?: () => void, on = sl) => {
		const env = { AGENT_SYSTEM_ROLE: "lane", AGENT_SYSTEM_LEDGER_DB: path, AGENT_SYSTEM_WORKLOAD_ID: train, AGENT_SYSTEM_LANE_ID: TRAIN_LANE, HOME: "/nonexistent-home" };
		const f = fakePi(undefined, { exec: true });
		const reply = (a: Answer) => (a === FAIL ? { stdout: "", stderr: "HTTP 502", code: 1, killed: false } : { stdout: JSON.stringify(a), stderr: "", code: 0, killed: false });
		f.execs.answer = (command, args) => {
			if (command !== "gh") return { stdout: "", stderr: "not gh", code: 127, killed: false };
			if (args[0] === "pr" && args[1] === "view") {
				duringGh?.();
				return reply(answers.view);
			}
			if (args[1] === `repos/${REPO}/rules/branches/main`) return reply(answers.rules);
			if (args[1] === `repos/${REPO}/rulesets/${RULESET}`) return reply(answers.ruleset);
			return { stdout: "", stderr: `unexpected gh ${args.join(" ")}`, code: 1, killed: false };
		};
		orchestratorSurface(f.pi, env);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		const r = await f.tool(LANE_RAISE_QUESTION_TOOL).execute("q1", { slice: on, body: `#${PR} green and mergeable at ${H1}; merged / skip / stop?`, options }, undefined, undefined, ctx);
		return { text: r.content[0]!.text, calls: f.execs.calls };
	};
	const applied = () => ledger.entries(train).filter((e) => e.body.startsWith("ruling-applied:")).map((e) => [e.created_by, e.slice_id, e.body]);
	return { ledger, train, owner, sl, full, work, ownerFull, run, reviewed, loopEnd, answers, ask, applied };
}

/** The decided case's ledger: W's review passed (one round, ended pass), a green on the train's suite slice at H1. */
function passing(w: World): void {
	w.reviewed("dt-1");
	w.loopEnd("pass");
	w.run(w.train, w.full, H1, "green");
}

/** Decided by train-signoff: no question row, the lane's `ruling-applied:`, the reply saying what to do. */
function expectDecided(w: World, text: string): void {
	expect(text).toStartWith("decided by Jo's ruling train-signoff: ");
	expect(text).toContain(`\`gh pr merge ${PR} -R ${REPO} --merge --match-head-commit ${H1}\``);
	expect(text).toContain("do not publish a QUESTION block");
	expect(w.ledger.questions(w.train)).toEqual([]);
	expect(w.ledger.slice(w.sl)!.state).toBe("open");
	expect(w.applied()).toEqual([[TRAIN_LANE, w.sl, `ruling-applied: train-signoff kind merge slice ${w.sl} answer merge`]]);
}

/** Raised as before: Jo's merged / skip / stop question, the slice paused, no `ruling-applied:`. */
function expectRaised(w: World, text: string): void {
	expect(text).toStartWith("Raised question ");
	expect(w.ledger.questions(w.train).map((q) => [q.slice_id, q.state, JSON.parse(q.options)])).toEqual([[w.sl, "open", OPTIONS]]);
	expect(w.ledger.slice(w.sl)!.state).toBe("paused");
	expect(w.applied()).toEqual([]);
}

describe("R1: a production PR Jo's train word named, reviewed, green at its head, main protected: decided with no question", () => {
	test("Jo's `train 101`: decided; gh read the PR, main's rules and the ruleset they name; the reply names the slice and the run", async () => {
		const w = world();
		passing(w);
		const { text, calls } = await w.ask();
		expectDecided(w, text);
		expect(calls.map((c) => [c.command, ...c.args.slice(0, 3)])).toEqual([
			["gh", "pr", "view", String(PR)],
			["gh", "api", `repos/${REPO}/rules/branches/main`],
			["gh", "api", `repos/${REPO}/rulesets/${RULESET}`],
		]);
		expect(calls[0]!.args).toEqual(["pr", "view", String(PR), "-R", REPO, "--json", expect.stringContaining("headRefOid")]);
		expect(text).toContain(`complete ${w.sl} with artifact \`merged by train <merge commit sha> (run `);
	});

	test("boarded by the tick first, then Jo's binding naming the PR (a resume `train <wl> 101`): decided", async () => {
		const w = world({ source: "board" });
		passing(w);
		const id = w.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: w.train, body: trainInstructionBody(w.train, [PR]) });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.train, kind: "assumption", body: trainBody([PR], id) });
		expectDecided(w, (await w.ask()).text);
	});

	test("the only green at the head is W's own run: decided", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.loopEnd("pass");
		w.run(w.owner, w.ownerFull, H1, "green");
		expectDecided(w, (await w.ask()).text);
	});

	test("Jo's accept ending the review loop counts as passed: decided", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.loopEnd("accept");
		w.run(w.train, w.full, H1, "green");
		expectDecided(w, (await w.ask()).text);
	});
});

describe("R2: every failing rule, or a gh read failing, leaves Jo's question raised", () => {
	test("rule 1: a PR only the tick boarded (no Jo train word names it)", async () => {
		const w = world({ source: "board" });
		passing(w);
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 1: Jo's binding names another PR only", async () => {
		const w = world({ source: "board" });
		passing(w);
		const id = w.ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: w.train, body: trainInstructionBody(w.train, [106]) });
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.train, kind: "assumption", body: trainBody([106], id) });
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 2: a head branch that is not wl/<id> (no ledger workload)", async () => {
		const w = world();
		passing(w);
		w.answers.view = { ...(w.answers.view as object), headRefName: "plumb/runner-hang" };
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 2: a fork", async () => {
		const w = world();
		passing(w);
		w.answers.view = { ...(w.answers.view as object), isCrossRepository: true, headRepositoryOwner: { login: "someone" } };
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 2: W's stakes are not production", async () => {
		const w = world({ stakes: "normal" });
		passing(w);
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 3: no review on W at all", async () => {
		const w = world();
		w.run(w.train, w.full, H1, "green");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 3: the review's loop ended stop, not pass or accept", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.loopEnd("stop");
		w.run(w.train, w.full, H1, "green");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 3: a review round with no loop end yet", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.run(w.train, w.full, H1, "green");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 3: a review dispatched after the pass and not settled", async () => {
		const w = world();
		passing(w);
		w.ledger.recordEntry({
			by: OWNER_LANE, workloadId: w.owner, sliceId: w.work, kind: "assumption",
			body: "hand-spawn: dt-2 session /sessions/dt-2 spawn - review yes group dg-dt-2 row anthropic/claude-opus-5-5",
		});
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 4: the newest green is at an older head", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.loopEnd("pass");
		w.run(w.train, w.full, H0, "green");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 4: a green at the head, then a newer red at it", async () => {
		const w = world();
		passing(w);
		w.run(w.owner, w.ownerFull, H1, "red");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 4: no green run at all", async () => {
		const w = world();
		w.reviewed("dt-1");
		w.loopEnd("pass");
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 5: main's protection has a gap (the merging account can bypass the ruleset)", async () => {
		const w = world();
		passing(w);
		w.answers.ruleset = { id: RULESET, enforcement: "active", current_user_can_bypass: "always" };
		expectRaised(w, (await w.ask()).text);
	});

	test("rule 5: main's protection is unknown (the ruleset read gives no bypass mode)", async () => {
		const w = world();
		passing(w);
		w.answers.ruleset = { message: "Not Found" };
		expectRaised(w, (await w.ask()).text);
	});

	test("gh pr view failing", async () => {
		const w = world();
		passing(w);
		w.answers.view = FAIL;
		expectRaised(w, (await w.ask()).text);
	});

	test("gh pr view answering a shape taskViewOf rejects", async () => {
		const w = world();
		passing(w);
		w.answers.view = { number: PR };
		expectRaised(w, (await w.ask()).text);
	});

	test("main's rules read failing", async () => {
		const w = world();
		passing(w);
		w.answers.rules = FAIL;
		expectRaised(w, (await w.ask()).text);
	});

	test("the ruleset read failing", async () => {
		const w = world();
		passing(w);
		w.answers.ruleset = FAIL;
		expectRaised(w, (await w.ask()).text);
	});

	test("a train question that is no merge question reads no gh and is raised", async () => {
		const w = world();
		passing(w);
		const { text, calls } = await w.ask(["retry", "skip", "stop"]);
		expect(text).toStartWith("Raised question ");
		expect(calls).toEqual([]);
		expect(w.applied()).toEqual([]);
	});
});

describe("R3: Jo's end-ruling train-signoff ends it with no code change", () => {
	test("the decided case, after Jo's `end-ruling train-signoff`, is raised", async () => {
		const w = world();
		passing(w);
		endRuling(w.ledger);
		expectRaised(w, (await w.ask()).text);
	});
});

describe("code review r1: the decision re-reads authority, leaves an open question Jo's, skips an auto-started plan's review, orders runs as the ledger does", () => {
	/** Nothing was written: no question row, the slice as it was left, no `ruling-applied:`. */
	const expectNothing = (w: World, state: string) => {
		expect(w.ledger.questions(w.train)).toEqual([]);
		expect(w.ledger.slice(w.sl)!.state).toBe(state);
		expect(w.applied()).toEqual([]);
	};

	test("finding 1: Jo takes the train while gh is read: refused as the guard refuses, no decision", async () => {
		const w = world();
		passing(w);
		const { text } = await w.ask(OPTIONS, () => {
			expect(w.ledger.releaseWorkload(w.train, { by: TRAIN_LANE, holder: TRAIN_LANE }).released).toBe(true);
			expect(w.ledger.claimWorkload(w.train, { by: SURFACE_BY, holder: JO_HOLDER, leaseMs: null }).won).toBe(true);
		});
		expect(text).toBe(`Workload ${w.train} is held by ${JO_HOLDER}, not by this lane (${TRAIN_LANE}) under a live lease; nothing was asked.`);
		expectNothing(w, "open");
	});

	test("finding 1: the train lane's lease lapses while gh is read: refused, no decision", async () => {
		const w = world();
		passing(w);
		const { text } = await w.ask(OPTIONS, () => {
			expect(w.ledger.claimWorkload(w.train, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: -60_000 }).won).toBe(true);
		});
		expect(text).toBe(`Workload ${w.train} is held by ${TRAIN_LANE} under a lapsed lease, not by this lane (${TRAIN_LANE}) under a live lease; nothing was asked.`);
		expectNothing(w, "open");
	});

	test("finding 1: the PR slice is cancelled while gh is read: refused, no decision", async () => {
		const w = world();
		passing(w);
		const { text } = await w.ask(OPTIONS, () => w.ledger.cancelSlice(w.sl, { by: SURFACE_BY }));
		expect(text).toBe(`Slice ${w.sl} is cancelled; nothing was asked.`);
		expectNothing(w, "cancelled");
	});

	test("finding 2: a merge question already open on the PR slice stays Jo's: asked again with every rule ok, a second question is raised", async () => {
		const w = world();
		passing(w);
		const before = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: w.sl, body: `#${PR} merged / skip / stop?`, options: OPTIONS });
		const { text } = await w.ask();
		expect(text).toStartWith("Raised question ");
		const open = w.ledger.questions(w.train).filter((q) => q.slice_id === w.sl && q.state === "open").map((q) => q.id);
		expect(open).toHaveLength(2);
		expect(open).toContain(before);
		expect(w.ledger.slice(w.sl)!.state).toBe("paused");
		expect(w.applied()).toEqual([]);
	});

	test("finding 3: an auto-started plan's passed review is no implementation review once W is production; a settled one then decides", async () => {
		/**
		 * W at normal stakes, its plan reviewed (ended pass) and started by the auto-start (no question row), then raised to
		 * production; the auto-start's hold (`planHold`) has run out: its notice delivered, Jo typed, HOLD_HOURS passed. The
		 * world's clock runs from HOLD_HOURS + 1 h ago, a second a step, then jumps to a minute ago, where the train lane's lease is renewed.
		 */
		const autoStarted = (): World => {
			let t = Date.now() - (HOLD_HOURS + 1) * 3_600_000;
			const w = world({ stakes: "normal", now: () => new Date((t += 1_000)).toISOString() });
			const plan = w.ledger.addSlice({ by: OWNER_LANE, workloadId: w.owner, task: "plan the header move", doneCondition: "plan approved", inputs: "the brief" });
			w.ledger.recordEntry({ by: OWNER_LANE, workloadId: w.owner, sliceId: plan, kind: "assumption", body: "hand-spawn: dp-1 session /sessions/dp-1 spawn - review yes group dg-dp-1 row openai-codex/gpt-6.1-sol" });
			w.ledger.recordEntry({ by: CLASSIFIER_BY, workloadId: w.owner, sliceId: plan, kind: "assumption", body: reviewRoundBody({ slice: plan, round: 1, token: "dp-1", group: "dg-dp-1", verdict: "accepted", findings: UNKNOWN }) });
			w.ledger.recordEntry({ by: OWNER_LANE, workloadId: w.owner, sliceId: plan, kind: "assumption", body: reviewLoopEndBody(plan, "pass") });
			w.ledger.recordEntry({ by: ESCALATION_BY, workloadId: w.owner, sliceId: plan, kind: "assumption", body: planAutoApprovedBody("dg-dp-1") });
			w.ledger.completeSlice(plan, { by: OWNER_LANE, artifact: "/plans/PLAN.md" });
			w.ledger.setStakes(w.owner, { by: SURFACE_BY, stakes: "production" });
			const notice = sendNotice(w.ledger, { by: ESCALATION_BY, workloadId: w.owner, body: planAutoStartNoticeBody(w.owner, "/plans/PLAN.md") });
			w.ledger.advanceMessage(notice, "delivered", { by: SURFACE_BY });
			ensureStandingWorkload(w.ledger);
			w.ledger.recordInstruction({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, body: "what's up", author: "jo", channel: "surface" });
			t = Date.now() - 60_000;
			expect(w.ledger.claimWorkload(w.train, { by: LANE_STARTER_BY, holder: TRAIN_LANE, leaseMs: 600_000 }).won).toBe(true);
			w.run(w.train, w.full, H1, "green");
			return w;
		};
		const planOnly = autoStarted();
		expect(planOnly.ledger.questions(planOnly.owner)).toEqual([]);
		expectRaised(planOnly, (await planOnly.ask()).text);
		const implemented = autoStarted();
		implemented.reviewed("dt-1");
		implemented.loopEnd("pass");
		expectDecided(implemented, (await implemented.ask()).text);
	});

	test("finding 4: runs in one millisecond on the train and on W are ordered as written, in both directions", async () => {
		/** A world on a stopped clock: every entry it writes has the same created_at. */
		const stopped = (): World => {
			const t = new Date().toISOString();
			const w = world({ now: () => t });
			w.reviewed("dt-1");
			w.loopEnd("pass");
			return w;
		};
		const wThenTrainRed = stopped();
		wThenTrainRed.run(wThenTrainRed.owner, wThenTrainRed.ownerFull, H1, "green");
		wThenTrainRed.run(wThenTrainRed.train, wThenTrainRed.full, H1, "red");
		expectRaised(wThenTrainRed, (await wThenTrainRed.ask()).text);
		const trainThenWRed = stopped();
		trainThenWRed.run(trainThenWRed.train, trainThenWRed.full, H1, "green");
		trainThenWRed.run(trainThenWRed.owner, trainThenWRed.ownerFull, H1, "red");
		expectRaised(trainThenWRed, (await trainThenWRed.ask()).text);
		const wRedThenTrainGreen = stopped();
		wRedThenTrainGreen.run(wRedThenTrainGreen.owner, wRedThenTrainGreen.ownerFull, H1, "red");
		wRedThenTrainGreen.run(wRedThenTrainGreen.train, wRedThenTrainGreen.full, H1, "green");
		expectDecided(wRedThenTrainGreen, (await wRedThenTrainGreen.ask()).text);
	});
});

describe("code review r2: Jo's halt and stop hold the sign-off, a pending plan's review is no implementation review, only the disposition slice asks", () => {
	/** Jo's `halt <W>` as the surface applies it: his instruction and `plan: halted <instruction>` on W. */
	const halt = (w: World) => apply(w.ledger, interpret(w.ledger, `halt ${w.owner}`)!);
	/** Jo's stop on the train at another PR (#106): a merge question on its disposition slice, answered `stop` by Jo. */
	const stop = (w: World): string => {
		const on = w.ledger.addSlice({ by: TRAIN_LANE, workloadId: w.train, id: trainSliceId(w.train, 106), task: "#106 on the train", doneCondition: "terminal", inputs: "PR #106" });
		const q = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: on, body: "#106 merged / skip / stop?", options: OPTIONS });
		w.ledger.answerQuestion(q, { by: SURFACE_BY, author: "jo", channel: "surface", answer: "stop" });
		return q;
	};
	/** The questions on the PR's disposition slice, as [state, options]. */
	const onSl = (w: World) => w.ledger.questions(w.train).filter((q) => q.slice_id === w.sl).map((q) => [q.state, JSON.parse(q.options)]);
	/** Raised on the disposition slice, other train rows (the stop's question) aside: open, paused, no `ruling-applied:`. */
	const expectRaisedOnSl = (w: World, text: string) => {
		expect(text).toStartWith("Raised question ");
		expect(onSl(w)).toEqual([["open", OPTIONS]]);
		expect(w.ledger.slice(w.sl)!.state).toBe("paused");
		expect(w.applied()).toEqual([]);
	};

	test("finding 1: Jo halted W before the ask: raised", async () => {
		const w = world();
		passing(w);
		expect(halt(w)).toContain(`${w.owner} is halted`);
		expectRaised(w, (await w.ask()).text);
	});

	test("finding 1: Jo halts W while gh is read: raised", async () => {
		const w = world();
		passing(w);
		expectRaised(w, (await w.ask(OPTIONS, () => void halt(w))).text);
	});

	test("finding 1: the auto-start's hold on W (its notice not yet delivered) holds the sign-off too: raised", async () => {
		const w = world({ stakes: "normal" });
		w.ledger.recordEntry({ by: ESCALATION_BY, workloadId: w.owner, kind: "assumption", body: planAutoApprovedBody("dg-dp-1") });
		w.ledger.setStakes(w.owner, { by: SURFACE_BY, stakes: "production" });
		passing(w);
		expectRaised(w, (await w.ask()).text);
	});

	test("finding 1: Jo stopped the train at another PR before the ask: raised", async () => {
		const w = world();
		passing(w);
		stop(w);
		expectRaisedOnSl(w, (await w.ask()).text);
	});

	test("finding 1: Jo stops the train at another PR while gh is read: raised", async () => {
		const w = world();
		passing(w);
		expectRaisedOnSl(w, (await w.ask(OPTIONS, () => void stop(w))).text);
	});

	test("finding 1: Jo's stop, then his resume `train <train> 101`: decided again", async () => {
		const w = world();
		passing(w);
		stop(w);
		expect(apply(w.ledger, interpret(w.ledger, `train ${w.train} ${PR}`)!)).toContain(`added #${PR} to merge train ${w.train}`);
		const { text } = await w.ask();
		expect(text).toStartWith("decided by Jo's ruling train-signoff: ");
		expect(onSl(w)).toEqual([]);
		expect(w.ledger.slice(w.sl)!.state).toBe("open");
		expect(w.applied()).toEqual([[TRAIN_LANE, w.sl, `ruling-applied: train-signoff kind merge slice ${w.sl} answer merge`]]);
	});

	test("finding 2: W is plan-first, its plan slice's review passed, no plan question yet, no implementation review: raised", async () => {
		const w = world();
		// `work` is W's first open slice, so under `plan: first` it holds the plan role (`planSlice`); its review is the plan's.
		w.ledger.recordEntry({ by: SURFACE_BY, workloadId: w.owner, kind: "assumption", body: planFirstBody("stakes production") });
		passing(w);
		expect(w.ledger.questions(w.owner)).toEqual([]);
		expectRaised(w, (await w.ask()).text);
		expect(reviewSettledPassed(w.ledger, w.owner)).toEqual({ ok: false, reason: `${w.owner} has no review on any slice` });
	});

	test("finding 3: a merge question on the PR's -full-<r> slice gets no fact: no gh read, raised there, no ruling-applied", async () => {
		const w = world();
		passing(w);
		const { text, calls } = await w.ask(OPTIONS, undefined, w.full);
		expect(text).toStartWith("Raised question ");
		expect(calls).toEqual([]);
		expect(w.ledger.questions(w.train).map((q) => [q.slice_id, q.state])).toEqual([[w.full, "open"]]);
		expect(w.applied()).toEqual([]);
	});

	test("finding 3: a question open on the PR's -full-<r> slice stays Jo's: asked on the disposition slice, raised", async () => {
		const w = world();
		passing(w);
		const before = w.ledger.raiseQuestion({ by: TRAIN_LANE, workloadId: w.train, sliceId: w.full, body: `#${PR} merged / skip / stop?`, options: OPTIONS });
		expectRaisedOnSl(w, (await w.ask()).text);
		expect(w.ledger.questions(w.train).find((q) => q.id === before)!.state).toBe("open");
	});
});

/** Jo's `end-ruling train-signoff` as the surface writes it: his instruction on the standing workload. */
function endRuling(ledger: Ledger): void {
	ensureStandingWorkload(ledger);
	ledger.recordInstruction({ by: SURFACE_BY, author: "jo", channel: "surface", workloadId: STANDING_WORKLOAD_ID, body: "end-ruling train-signoff" });
}
