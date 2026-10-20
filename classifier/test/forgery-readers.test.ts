// R16 (PLAN wl-mvfxw3c4zqfzls D7): the Jo-authority readers read Jo's authority through one predicate,
// ledger/src/authority.ts joAuthority (author 'jo' written by 'orchestrator-surface'). A row authored 'jo' but
// stamped by anything joAuthority rejects — the lane starter, a lane's own id — no longer counts for any of them.
// Every case has a positive control: the same row stamped by the surface does count, so a reader that ignores
// everything cannot pass.
//
// Readers moved here: classifier/src/lab.ts unspentGrant; surface/extensions/lane-tools.ts planReviewed (its
// round-limit `accept` read and its same-lab grant read); surface/src/pair-suggest.ts (long steers and plan
// revises, through mechanicalEligibility); classifier/src/rounds.ts effectiveRoundLimit's stakes flip;
// classifier/src/review-stop.ts reviewStopOn; surface/src/orchestrator-question.ts isJoInput.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, type InstructionRow, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { planReviewed } from "../../surface/extensions/lane-tools";
import { PLAN_OPTIONS, planFirstBody, planQuestionBody } from "../../surface/src/launch";
import { isJoInput } from "../../surface/src/orchestrator-question";
import { mechanicalEligibility } from "../../surface/src/pair-suggest";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../../surface/src/types";
import { handSettledBody, handSpawnBody, laneBuilderBody, PARK_OPTIONS, reviewParkBody, reviewSameLabBody, unspentGrant } from "../src/lab";
import { effectiveRoundLimit, REVIEW_ROUND_DEFAULTS, ROUND_LIMIT_OPTIONS, reviewLimitBody, reviewRoundBody } from "../src/rounds";
import { reviewStopOn } from "../src/review-stop";

const LANE = "lane-forgeryreaders-1";
const LANE_MODEL = "anthropic/claude-opus-5-5";
const OTHER_LAB = "openai-codex/gpt-6-astra";
/** Stamps joAuthority rejects on an author-jo row: the by-hand launcher's, and a lane's own id. */
const FORGED = [LANE_STARTER_BY, LANE] as const;

let tick = Date.parse("2026-10-19T00:00:00.000Z");
const clock = () => new Date((tick += 1000)).toISOString();

interface Fixture {
	l: Ledger;
	wl: string;
	plan: string;
	/** An author-jo instruction stamped `by`. */
	jo: (by: string, body: string) => string;
	/** An author-jo answer to `question` stamped `by`. */
	answer: (by: string, question: string, word: string) => string;
	/** An entry the lane writes on the plan slice. */
	lane: (body: string) => string;
}

const channelOf = (by: string): Channel => (by === SURFACE_BY ? "surface" : "direct");

/** A workload held by LANE, whose builder lab is anthropic, with a plan slice. */
function fixture(): Fixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "forgery-readers-")));
	const l = Ledger.open(join(dir, "ledger.db"), { create: true, clock, backup: false, backupOnOpen: false });
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "forgery readers", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
	l.recordEntry({ by: LANE, workloadId: wl, kind: "assumption", body: laneBuilderBody("anthropic", LANE, LANE_MODEL) });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by test` });
	l.claimWorkload(wl, { by: LANE_STARTER_BY, holder: LANE, leaseMs: 3_600_000 });
	const plan = l.addSlice({ by: LANE, workloadId: wl, task: "plan", doneCondition: "Jo approves", inputs: "brief" });
	return {
		l,
		wl,
		plan,
		jo: (by, body) => l.recordInstruction({ by, workloadId: wl, body, author: "jo", channel: channelOf(by) }),
		answer: (by, question, word) => l.answerQuestion(question, { by, answer: word, author: "jo", channel: channelOf(by) }),
		lane: (body) => l.recordEntry({ by: LANE, workloadId: wl, sliceId: plan, kind: "assumption", body }),
	};
}

let seq = 0;

/** One settled review hand on the plan slice (as surface/test/lane-tools.test.ts seedReview writes it). */
function review(f: Fixture, over: { ran: string; grant?: string; round?: number }): { token: string; routing: string } {
	const n = ++seq;
	const token = `dt-fr${n}`;
	const group = `dg-fr${n}`;
	if (over.grant) f.lane(reviewSameLabBody(over.grant, token));
	f.lane(handSpawnBody({ token, root: `/tmp/${LANE}`, spawnKey: f.plan, review: true, group, row: [over.ran] }));
	const routing = f.l.recordRouting({
		by: LANE, workloadId: f.wl, sliceId: f.plan, spawnKey: f.plan, sessionRoot: `/tmp/${LANE}`, agentId: `${f.plan}-${n}`,
		kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
		models: [over.ran], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [over.ran],
	});
	f.lane(handSettledBody(token, routing));
	if (over.round !== undefined) {
		f.lane(reviewRoundBody({
			slice: f.plan, round: over.round, token, group, verdict: "accepted",
			findings: { counts: { blocking: { correctness: 1 }, major: {}, minor: {} }, titles: [] },
		}));
	}
	return { token, routing };
}

/** The classifier's park question on the plan slice, with its `review-park:` entry. */
function park(f: Fixture): string {
	const q = f.l.raiseQuestion({ by: LANE, workloadId: f.wl, sliceId: f.plan, body: "No lab other than the builder's can review", options: [...PARK_OPTIONS] });
	f.lane(reviewParkBody(q, f.plan));
	return q;
}

describe("classifier/src/lab.ts unspentGrant", () => {
	for (const by of [...FORGED, SURFACE_BY]) {
		const counts = by === SURFACE_BY;
		test(`a same-lab answer stamped ${by} ${counts ? "grants (control)" : "grants nothing"}`, () => {
			const f = fixture();
			const id = f.answer(by, park(f), "same-lab");
			expect(unspentGrant(f.l.entries(f.wl), f.l.instructions(f.wl), f.plan)).toBe(counts ? id : null);
			f.l.close();
		});
	}
});

describe("surface/extensions/lane-tools.ts planReviewed", () => {
	for (const by of [...FORGED, SURFACE_BY]) {
		const counts = by === SURFACE_BY;
		test(`same-lab grant: a builder-lab review the answer stamped ${by} granted ${counts ? "clears the plan (control)" : "clears nothing"}`, () => {
			const f = fixture();
			const grant = f.answer(by, park(f), "same-lab");
			review(f, { ran: LANE_MODEL, grant });
			expect(planReviewed(f.l, f.wl, f.plan)).toBe(counts);
			f.l.close();
		});

		test(`round limit: an \`accept\` stamped ${by} ${counts ? "clears the plan on the limit-reaching round (control)" : "is no accept"}`, () => {
			const f = fixture();
			review(f, { ran: OTHER_LAB, round: 1 });
			const limit = f.l.raiseQuestion({ by: LANE, workloadId: f.wl, sliceId: f.plan, body: "the review is at its round limit", options: [...ROUND_LIMIT_OPTIONS] });
			f.lane(reviewLimitBody(limit, f.plan));
			f.answer(by, limit, "accept");
			expect(planReviewed(f.l, f.wl, f.plan)).toBe(counts);
			f.l.close();
		});
	}
});

describe("surface/src/pair-suggest.ts mechanicalEligibility", () => {
	const LONG = "Use the existing token scale rather than new pixel values, and keep the header aligned with the sidebar grid.";

	for (const by of [...FORGED, SURFACE_BY]) {
		const counts = by === SURFACE_BY;
		test(`two plan revises stamped ${by} ${counts ? "add one to B (control)" : "add nothing"}`, () => {
			const f = fixture();
			f.jo(SURFACE_BY, `Jo: "${LONG}" — reading: steer the lane`);
			f.jo(SURFACE_BY, `Jo: "${LONG}" — reading: steer the lane`);
			for (let i = 1; i <= 2; i++) {
				const plan = f.l.addSlice({ by: LANE, workloadId: f.wl, task: `plan ${i}`, doneCondition: "Jo approves", inputs: "brief" });
				const q = f.l.raiseQuestion({ by: LANE, workloadId: f.wl, sliceId: plan, body: "/tmp/PLAN.md\n- sl-a: a\ntradeoff: t\nreview: approve, m, /tmp/R.md", options: [...PLAN_OPTIONS] });
				f.l.recordEntry({ by: LANE, workloadId: f.wl, sliceId: plan, kind: "assumption", body: planQuestionBody(q) });
				f.answer(by, q, "revise");
			}
			expect(mechanicalEligibility(f.l, f.wl, f.l.now()).eligible).toBe(counts);
			f.l.close();
		});

		test(`three long steers stamped ${by} ${counts ? "fire B (control)" : "fire nothing"}`, () => {
			const f = fixture();
			for (let i = 0; i < 3; i++) f.l.recordInstruction({ by, workloadId: f.wl, body: `Jo: "${LONG}" — reading: steer`, author: "jo", channel: "surface" });
			expect(mechanicalEligibility(f.l, f.wl, f.l.now()).eligible).toBe(counts);
			f.l.close();
		});
	}
});

describe("classifier/src/rounds.ts effectiveRoundLimit: the stakes flip", () => {
	for (const by of [...FORGED, SURFACE_BY]) {
		const counts = by === SURFACE_BY;
		test(`a \`stakes:\` stamped ${by} ${counts ? "re-sizes a limit Jo set (control)" : "re-sizes nothing"}`, () => {
			const f = fixture();
			const rounds = f.jo(SURFACE_BY, "rounds: 9");
			f.l.recordEntry({ by: SURFACE_BY, workloadId: f.wl, kind: "assumption", body: `review-rounds: 9 source rounds by ${rounds}` });
			f.jo(by, "stakes: normal");
			expect(effectiveRoundLimit(f.l.entries(f.wl), f.l.instructions(f.wl), "normal", f.plan).workload).toBe(counts ? REVIEW_ROUND_DEFAULTS.normal : 9);
			f.l.close();
		});
	}
});

describe("classifier/src/review-stop.ts reviewStopOn", () => {
	for (const by of [...FORGED, SURFACE_BY]) {
		const counts = by === SURFACE_BY;
		test(`a review-stop naming a \`stop-reviews:\` stamped ${by} ${counts ? "stops the loop (control)" : "stops nothing"}`, () => {
			const f = fixture();
			const id = f.jo(by, `stop-reviews: ${f.wl}`);
			f.l.recordEntry({ by: SURFACE_BY, workloadId: f.wl, kind: "assumption", body: `review-stop: ${f.wl} by ${id}` });
			expect(reviewStopOn(f.l.entries(f.wl), f.l.instructions(f.wl), f.wl, f.plan)).toBe(counts ? id : null);
			f.l.close();
		});
	}
});

describe("surface/src/orchestrator-question.ts isJoInput", () => {
	const row = (created_by: string): InstructionRow => ({
		id: "in-forgeryreaders1", workload_id: STANDING_WORKLOAD_ID, slice_id: null, kind: "instruction", question_id: null, disposition: null,
		channel: "surface", author: "jo", body: "go", created_by, created_at: clock(),
	});

	for (const by of [...FORGED, SURFACE_BY]) {
		test(`an author-jo surface-channel row stamped ${by} ${by === SURFACE_BY ? "is Jo's input (control)" : "is not Jo's input"}`, () => {
			expect(isJoInput(row(by))).toBe(by === SURFACE_BY);
		});
	}
});
