// The Jo-only boundary, accident grade, layer 4: the readers (PLAN wl-mv654hoqwpfhmo § 6.3 item 4).
//
// Row 11's direct channel (gates/src/rows/r11-jo-instruction.ts `recordJoInstruction`) stamps Jo's typed words with
// the lane's own id: author 'jo', kind 'instruction', channel 'direct', question_id NULL, created_by <lane id>. Those
// are Jo's words, not Jo's authority (ledger/src/authority.ts lists the channel as "words, not authority"), so no
// reader may take one as `ceiling:`, `rounds`, `stop-reviews`, `cap`, `switch` or a question answer. Every case below
// writes the row through the real row-11 writer, then has a positive control: the same word written by the surface
// (author 'jo', created_by 'orchestrator-surface') does satisfy the reader, so a reader that ignores everything
// cannot pass.
//
// Readers on main (found by grep for author/created_by checks on instructions):
// - ceiling: surface/src/ceiling.ts `effectiveCeiling`
// - rounds (and the stakes flip that re-sizes them): classifier/src/rounds.ts `effectiveRoundLimit`
// - stop-reviews: classifier/src/review-stop.ts `reviewStopOn`
// - question answers: the question row itself (`Ledger.questions`), surface/src/launch.ts `resolutions` and
//   `planFirst`, classifier/src/lab.ts `unspentGrant`
// - cap and switch: none on main; PR-B (`sl-caps-enforce`, `sl-caps-switch`) adds them after PR-C merges.
//
// Interface this file fixes for the boundary (sl-auth-boundary): `ledger/src/authority.ts` exports
//     joAuthority(i: Pick<InstructionRow, "author" | "created_by">): boolean
// true only for author 'jo' written by 'orchestrator-surface'. It is the predicate every reader of Jo's authority
// uses from PR-C on, and the one PR-B's cap and switch readers call; the cap and switch cases test it directly. It is
// loaded with a dynamic import in the tests that need it, so a missing authority.ts fails only those.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordJoInstruction } from "../../gates/src/rows/r11-jo-instruction";
import { type InstructionRow, LANE_STARTER_BY, Ledger } from "../../ledger/src/index";
import { effectiveCeiling, sizeFor } from "../../surface/src/ceiling";
import { controlEntries, planFirst, resolutions } from "../../surface/src/launch";
import { SURFACE_BY } from "../../surface/src/types";
import { reviewParkBody, unspentGrant } from "../src/lab";
import { REVIEW_ROUND_DEFAULTS, effectiveRoundLimit } from "../src/rounds";
import { reviewStopOn } from "../src/review-stop";

const LANE = "lane-authreaders-1";

let tick = Date.parse("2026-10-19T00:00:00.000Z");
const clock = () => new Date((tick += 1000)).toISOString();

interface Fixture {
	l: Ledger;
	wl: string;
	slice: string;
	/** Jo's words as row 11 records them: the lane's stamp, channel direct. */
	row11: (text: string) => string;
	/** The same words as the surface records them: Jo's authority. */
	surface: (text: string) => string;
	/** A control line the surface writes (the shape every reader below trusts). */
	control: (body: string) => string;
}

function fixture(): Fixture {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "authority-readers-")));
	const l = Ledger.open(join(dir, "ledger.db"), { create: true, clock, backup: false });
	const wl = l.openWorkload({ by: SURFACE_BY, brief: "authority readers", stakes: "normal", mode: "autonomous" });
	l.recordEntry({ by: LANE_STARTER_BY, workloadId: wl, kind: "assumption", body: `launch: ${LANE} cause first requested-by jo` });
	l.claimWorkload(wl, { by: LANE, holder: LANE, leaseMs: 3_600_000 });
	const slice = l.addSlice({ by: LANE, workloadId: wl, task: "plan", doneCondition: "d", inputs: "i" });
	return {
		l,
		wl,
		slice,
		row11: (text) => recordJoInstruction(l, { text, source: "interactive", workloadId: wl, laneId: LANE })!,
		surface: (text) => l.recordInstruction({ by: SURFACE_BY, workloadId: wl, body: text, author: "jo", channel: "surface" }),
		control: (body) => l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body }),
	};
}

describe("row 11's shape is what the tests below write", () => {
	test("recordJoInstruction stamps the lane: author jo, kind instruction, channel direct, no question", () => {
		const f = fixture();
		const id = f.row11("ceiling: 500 12");
		expect(f.l.instructions(f.wl).find((i) => i.id === id)).toMatchObject({ author: "jo", kind: "instruction", channel: "direct", question_id: null, created_by: LANE });
		f.l.close();
	});
});

describe("ceiling: surface/src/ceiling.ts effectiveCeiling", () => {
	const RAISE = { usd: 500, wallMin: 720 };
	const raised = (f: Fixture, by: string) => {
		f.control(`ceiling: usd ${RAISE.usd} wall ${RAISE.wallMin} source jo ceiling by ${by}`);
		return effectiveCeiling(controlEntries(f.l.entries(f.wl)), f.l.instructions(f.wl), "normal");
	};

	test("a raise naming a row-11 `ceiling: 500 12` is ignored", () => {
		const f = fixture();
		f.control("ceiling: usd 20 wall 120 source stakes normal");
		expect(raised(f, f.row11("ceiling: 500 12"))).toEqual({ usd: 20, wallMin: 120 });
		f.l.close();
	});

	test("a raise naming a row-11 `stakes: production` is ignored", () => {
		const f = fixture();
		f.control("ceiling: usd 20 wall 120 source stakes normal");
		expect(raised(f, f.row11("stakes: production"))).toEqual({ usd: 20, wallMin: 120 });
		f.l.close();
	});

	test("control: the same raise naming the surface's `ceiling: 500 12` applies", () => {
		const f = fixture();
		f.control("ceiling: usd 20 wall 120 source stakes normal");
		expect(raised(f, f.surface("ceiling: 500 12"))).toEqual(RAISE);
		f.l.close();
	});

	test("with no ceiling entry the stakes size stands, whatever row 11 says", () => {
		const f = fixture();
		f.row11("ceiling: 500 12");
		expect(effectiveCeiling(controlEntries(f.l.entries(f.wl)), f.l.instructions(f.wl), "normal")).toEqual(sizeFor("normal", null));
		f.l.close();
	});
});

describe("rounds: classifier/src/rounds.ts effectiveRoundLimit", () => {
	const limit = (f: Fixture) => effectiveRoundLimit(f.l.entries(f.wl), f.l.instructions(f.wl), "normal", f.slice).workload;

	test("a `review-rounds: 9` naming a row-11 `rounds: 9` is ignored", () => {
		const f = fixture();
		f.control(`review-rounds: 9 source rounds by ${f.row11("rounds: 9")}`);
		expect(limit(f)).toBe(REVIEW_ROUND_DEFAULTS.normal);
		f.l.close();
	});

	test("control: naming the surface's `rounds: 9` applies", () => {
		const f = fixture();
		f.control(`review-rounds: 9 source rounds by ${f.surface("rounds: 9")}`);
		expect(limit(f)).toBe(9);
		f.l.close();
	});

	test("a row-11 `stakes: …` is no stakes flip: it does not re-size a limit Jo set", () => {
		const f = fixture();
		f.control(`review-rounds: 9 source rounds by ${f.surface("rounds: 9")}`);
		f.row11("stakes: throwaway");
		expect(limit(f)).toBe(9);
		f.surface("stakes: normal");
		expect(limit(f)).toBe(REVIEW_ROUND_DEFAULTS.normal); // control: the surface's flip does re-size
		f.l.close();
	});
});

describe("stop-reviews: classifier/src/review-stop.ts reviewStopOn", () => {
	test("a `review-stop:` naming a row-11 `stop-reviews: <wl>` stops nothing", () => {
		const f = fixture();
		f.control(`review-stop: ${f.wl} by ${f.row11(`stop-reviews: ${f.wl}`)}`);
		expect(reviewStopOn(f.l.entries(f.wl), f.l.instructions(f.wl), f.wl, f.slice)).toBeNull();
		f.l.close();
	});

	test("a `review-stop:` naming a row-11 `stop-reviews: <sl>` stops nothing", () => {
		const f = fixture();
		f.control(`review-stop: ${f.slice} by ${f.row11(`stop-reviews: ${f.slice}`)}`);
		expect(reviewStopOn(f.l.entries(f.wl), f.l.instructions(f.wl), f.wl, f.slice)).toBeNull();
		f.l.close();
	});

	test("control: naming the surface's `stop-reviews: <wl>` stops the loop", () => {
		const f = fixture();
		const id = f.surface(`stop-reviews: ${f.wl}`);
		f.control(`review-stop: ${f.wl} by ${id}`);
		expect(reviewStopOn(f.l.entries(f.wl), f.l.instructions(f.wl), f.wl, f.slice)).toBe(id);
		f.l.close();
	});
});

describe("question answers", () => {
	function asked(f: Fixture): string {
		f.control("plan: first jo said plan it");
		return f.l.raiseQuestion({ by: LANE, workloadId: f.wl, sliceId: f.slice, body: "approve the plan?", options: ["approve", "revise", "cancel"] });
	}

	test("a row-11 `approve` while the plan question is open: the question stays open, no resolution, plan: first stands", () => {
		const f = fixture();
		const q = asked(f);
		f.row11("approve");
		f.row11(`answer ${q} approve`);
		expect(f.l.questions(f.wl).find((x) => x.id === q)).toMatchObject({ state: "open", resolved_by: null });
		const control = controlEntries(f.l.entries(f.wl));
		expect(resolutions(control, f.l.questions(f.wl), f.l.instructions(f.wl), f.l.slices(f.wl))).toEqual([]);
		expect(planFirst(control)).not.toBeNull();
		f.l.close();
	});

	test("control: the surface's answer resolves it and is a resolution", () => {
		const f = fixture();
		const q = asked(f);
		const id = f.l.answerQuestion(q, { by: SURFACE_BY, answer: "revise", author: "jo", channel: "surface" });
		const r = resolutions(controlEntries(f.l.entries(f.wl)), f.l.questions(f.wl), f.l.instructions(f.wl), f.l.slices(f.wl));
		expect(r.map((x) => [x.instructionId, x.questionId, x.kind])).toEqual([[id, q, "answer"]]);
		f.l.close();
	});

	test("a row-11 `same-lab` grants no same-lab review on a park question (classifier/src/lab.ts unspentGrant)", () => {
		const f = fixture();
		const q = f.l.raiseQuestion({ by: LANE, workloadId: f.wl, sliceId: f.slice, body: "no other lab can review: wait or same-lab?", options: ["wait", "same-lab"] });
		f.l.recordEntry({ by: LANE, workloadId: f.wl, kind: "assumption", body: reviewParkBody(q, f.slice) });
		f.row11("same-lab");
		expect(unspentGrant(f.l.entries(f.wl), f.l.instructions(f.wl), f.slice)).toBeNull();
		const id = f.l.answerQuestion(q, { by: SURFACE_BY, answer: "same-lab", author: "jo", channel: "surface" });
		expect(unspentGrant(f.l.entries(f.wl), f.l.instructions(f.wl), f.slice)).toBe(id); // control
		f.l.close();
	});
});

describe("the one predicate (ledger/src/authority.ts joAuthority): cap, switch, and every word above", () => {
	async function joAuthority(): Promise<(i: Pick<InstructionRow, "author" | "created_by">) => boolean> {
		// Dynamic on purpose: authority.ts is new in PR-C, and a static import would fail every test in this file on main.
		const mod: Record<string, unknown> = await import("../../ledger/src/authority");
		const fn = mod.joAuthority as (i: Pick<InstructionRow, "author" | "created_by">) => boolean; // the header's interface
		return fn;
	}
	const WORDS = [
		"cap tokens-run 400000000",
		"cap mem-lane 16000000000 wl-x",
		"switch phoenix-tracing on lane-x-1",
		"switch hard-caps off all",
		"ceiling: 500 12",
		"stakes: production",
		"rounds: 9",
		"stop-reviews: wl-x",
		"approve",
		"extend",
		"same-lab",
	];

	test("cap and switch words (and every other word) on row 11 carry no authority", async () => {
		const isJo = await joAuthority();
		const f = fixture();
		for (const w of WORDS) {
			const id = f.row11(w);
			const row = f.l.instructions(f.wl).find((i) => i.id === id)!;
			expect(isJo(row), w).toBe(false);
		}
		f.l.close();
	});

	test("control: the same words written by the surface carry Jo's authority", async () => {
		const isJo = await joAuthority();
		const f = fixture();
		for (const w of WORDS) {
			const id = f.surface(w);
			const row = f.l.instructions(f.wl).find((i) => i.id === id)!;
			expect(isJo(row), w).toBe(true);
		}
		f.l.close();
	});

	test("an author other than jo is never Jo's authority, whoever wrote it", async () => {
		const isJo = await joAuthority();
		expect(isJo({ author: "orchestrator", created_by: SURFACE_BY })).toBe(false);
		expect(isJo({ author: "lane-runner", created_by: "lane-runner" })).toBe(false);
		expect(isJo({ author: "jo", created_by: "lane-plumb-by-hand" })).toBe(false);
	});
});
