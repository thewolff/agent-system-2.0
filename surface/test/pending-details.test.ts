// Authored pending-row metadata (PLAN wl-mv7gidggnlkem8 § Settled core contract): boundary validation
// of names and asks, the creator's writes inside its own creation transaction, the reader's trust rule
// (creator or importer, current source hash, valid value, first wins), the fixed standing name, and the
// missing-only import of a reviewed manifest. Driven through the ledger module as the source writers
// and the backfill tool will call it.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../../ledger/src/index";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { questionSubjectBody } from "../src/orchestrator-question";
import * as core from "../src/pending-details";
import { STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { tempLedger } from "./helpers";

const LANE = "lane-t-1";

/** The refusal message `fn` throws, or null when it returns. */
function refusal(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

const open = (ledger: Ledger, brief: string): string => ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });

/** A lane's slice and its open question on `wl`, neither described. */
function laneQuestion(ledger: Ledger, wl: string, body = "Left or right?"): string {
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Pick the token", doneCondition: "d", inputs: "i" });
	return ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body, options: ["left", "right"] });
}

const workHash = (ledger: Ledger, wl: string): string => core.workSourceHash(ledger.workload(wl)!);
const askHash = (ledger: Ledger, q: string, subject: string | null = null): string => core.questionSourceHash(ledger.question(q)!, subject);

describe("names and asks at the boundary", () => {
	test("a name is 1 to 80 code points of one plain line, with no hidden, separator or fence character and no bare id", () => {
		for (const ok of ["Feed header offset", "名前とémoji 😀", "😀".repeat(80), "a".repeat(80)]) expect({ ok, p: core.nameProblem(ok) }).toEqual({ ok, p: null });
		const bad = [
			"", "a".repeat(81), "😀".repeat(81), " padded", "padded ", "line\nbreak", "carriage\rreturn", "tab\tname",
			"rtl\u202Eevil", "isolate\u2066x\u2069", "zero\u200Bwidth", "joiner\u200Dx", "bom\uFEFFx", "line\u2028sep", "para\u2029sep",
			"has ``` fence", "has ~~~ fence", "wl-mv7gidggnlkem8", "q-mv8g6i5lvq", "en-abc123", "WL-ABC",
		];
		for (const name of bad) expect({ name, p: core.nameProblem(name) }).toEqual({ name, p: expect.any(String) });
		expect(core.nameProblem("bidi\u202Eevil")).toContain("U+202E");
	});

	test("an ask is one plain question of 1 to 320 code points ending with ?", () => {
		for (const ok of ["Which token name should replace the header offset?", `${"a".repeat(319)}?`, "Is wl-abc done?"]) expect({ ok, p: core.askProblem(ok) }).toEqual({ ok, p: null });
		for (const ask of ["", `${"a".repeat(320)}?`, "No question mark.", "Two\nlines?", "Hidden\u2066order?", "Fenced ``` ask?", " Padded?"]) {
			expect({ ask, p: core.askProblem(ask) }).toEqual({ ask, p: expect.any(String) });
		}
	});

	test("only an unbound orchestrator question carries a name; a bound one inherits its workload's", () => {
		const ask = "Which token name should replace the header offset?";
		expect(core.questionFieldsProblem({ ask, unbound: true })).toContain("needs a name");
		expect(core.questionFieldsProblem({ ask, name: "Feed header offset", unbound: true })).toBeNull();
		expect(core.questionFieldsProblem({ ask, name: "Feed header offset", unbound: false })).toContain("takes that workload's name");
		expect(core.questionFieldsProblem({ ask, unbound: false })).toBeNull();
		expect(core.questionFieldsProblem({ ask, name: "line\nbreak", unbound: true })).toContain("one plain line");
	});
});

describe("work names", () => {
	test("written in the creator's transaction: an invalid name leaves neither the workload nor metadata", () => {
		const { ledger } = tempLedger();
		const before = ledger.inFlight().length;
		const refused = refusal(() => ledger.write(() => {
			const wl = open(ledger, "Move the header offset into a token");
			core.recordWorkName(ledger, { workloadId: wl, by: SURFACE_BY, name: "Feed\nheader" });
		}));
		expect(refused).toContain("one plain line");
		expect(ledger.inFlight().length).toBe(before);
		const wl = ledger.write(() => {
			const id = open(ledger, "Move the header offset into a token");
			core.recordWorkName(ledger, { workloadId: id, by: SURFACE_BY, name: "Feed header offset" });
			return id;
		});
		expect(core.workName(ledger, wl)).toEqual({ name: "Feed header offset", sourceHash: workHash(ledger, wl), entryId: expect.stringMatching(/^en-/) });
		expect(ledger.entries(wl).at(-1)!.body).toBe(`work-name: ${JSON.stringify({ name: "Feed header offset", sourceHash: workHash(ledger, wl) })}`);
	});

	test("never replaced: the same name again is a no-op, a different one and another writer are refused", () => {
		const { ledger } = tempLedger();
		const wl = open(ledger, "Move the header offset into a token");
		expect(refusal(() => core.recordWorkName(ledger, { workloadId: wl, by: LANE, name: "Lane's label" }))).toContain(`only ${SURFACE_BY}`);
		expect(refusal(() => core.recordWorkName(ledger, { workloadId: wl, by: SURFACE_BY, name: "Feed header offset" }))).toBeNull();
		const entries = ledger.entries(wl).length;
		expect(refusal(() => core.recordWorkName(ledger, { workloadId: wl, by: SURFACE_BY, name: "Feed header offset" }))).toBeNull();
		expect(refusal(() => core.recordWorkName(ledger, { workloadId: wl, by: SURFACE_BY, name: "Header token" }))).toContain("never replaced");
		expect(ledger.entries(wl).length).toBe(entries);
		expect(core.workName(ledger, wl)?.name).toBe("Feed header offset");
	});

	test("the standing workload has its fixed name with no entry, and takes none", () => {
		const { ledger } = tempLedger();
		expect(core.workName(ledger, STANDING_WORKLOAD_ID)).toEqual({ name: "Orchestrator decisions", sourceHash: null, entryId: null });
		ensureStandingWorkload(ledger);
		const entries = ledger.entries(STANDING_WORKLOAD_ID).length;
		expect(refusal(() => core.recordWorkName(ledger, { workloadId: STANDING_WORKLOAD_ID, by: SURFACE_BY, name: "Something else" }))).toContain("fixed name");
		expect(ledger.entries(STANDING_WORKLOAD_ID).length).toBe(entries);
		expect(core.workName(ledger, STANDING_WORKLOAD_ID)?.name).toBe("Orchestrator decisions");
	});

	test("the reader trusts the creator or importer, the current source hash and a valid exact value; the first wins; a read-only ledger serves", () => {
		const { ledger, path } = tempLedger();
		const wl = open(ledger, "Move the header offset into a token");
		const other = open(ledger, "Another piece of work");
		const body = (name: string, sourceHash: string) => `work-name: ${JSON.stringify({ name, sourceHash })}`;
		const put = (by: string, b: string) => ledger.recordEntry({ by, workloadId: wl, kind: "assumption", body: b });
		put(LANE, body("Lane's forgery", workHash(ledger, wl)));
		put(SURFACE_BY, body("Another work's hash", workHash(ledger, other)));
		put(SURFACE_BY, body("Bidi\u202Etrick", workHash(ledger, wl)));
		put(SURFACE_BY, `work-name: ${JSON.stringify({ sourceHash: workHash(ledger, wl), name: "Reordered keys" })}`);
		put(SURFACE_BY, `work-name: ${JSON.stringify({ name: "Extra key", sourceHash: workHash(ledger, wl), origin: "source" })}`);
		expect(core.workName(ledger, wl)).toBeNull();
		const first = put(SURFACE_BY, body("Feed header offset", workHash(ledger, wl)));
		put(SURFACE_BY, body("Later label", workHash(ledger, wl)));
		expect(core.workName(ledger, wl)).toEqual({ name: "Feed header offset", sourceHash: workHash(ledger, wl), entryId: first });
		const reader = Ledger.open(path, { readonly: true });
		try {
			expect(core.workName(reader, wl)?.entryId).toBe(first);
		} finally {
			reader.close();
		}
	});
});

describe("question asks", () => {
	test("written with the question in one transaction; a legacy workload with no name does not stop it", () => {
		const { ledger } = tempLedger();
		const wl = open(ledger, "Move the header offset into a token");
		const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Pick the token", doneCondition: "d", inputs: "i" });
		const raise = (ask: string) => ledger.write(() => {
			const q = ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body: "left or right, see the notes", options: ["left", "right"] });
			core.recordQuestionDetails(ledger, { questionId: q, by: LANE, ask });
			return q;
		});
		expect(refusal(() => raise("left or right"))).toContain("ending with ?");
		expect(ledger.questions(wl)).toEqual([]);
		const q = raise("Which token name should replace the header offset?");
		expect(core.workName(ledger, wl)).toBeNull();
		expect(core.questionDetails(ledger, q)).toEqual({ ask: "Which token name should replace the header offset?", sourceHash: askHash(ledger, q), entryId: expect.stringMatching(/^en-/) });
		expect(core.missingDescriptions(ledger)).toEqual([wl]);
	});

	test("the creator alone describes its question, a bound question takes no name, and details are never replaced", () => {
		const { ledger } = tempLedger();
		const wl = open(ledger, "Move the header offset into a token");
		const q = laneQuestion(ledger, wl);
		const ask = "Should the header offset become the left token or the right one?";
		expect(refusal(() => core.recordQuestionDetails(ledger, { questionId: q, by: SURFACE_BY, ask }))).toContain(`only ${LANE}`);
		expect(refusal(() => core.recordQuestionDetails(ledger, { questionId: q, by: LANE, ask, name: "Feed header offset" }))).toContain("takes that workload's name");
		// Another lane's ask on a question it did not raise is no ask at all, and fills no gap.
		ledger.recordEntry({ by: "lane-other-1", workloadId: wl, kind: "assumption", body: `question-pending: ${JSON.stringify({ questionId: q, ask: "Forged?", sourceHash: askHash(ledger, q) })}` });
		expect(core.questionDetails(ledger, q)).toBeNull();
		expect(refusal(() => core.recordQuestionDetails(ledger, { questionId: q, by: LANE, ask }))).toBeNull();
		const entries = ledger.entries(wl).length;
		expect(refusal(() => core.recordQuestionDetails(ledger, { questionId: q, by: LANE, ask }))).toBeNull();
		expect(refusal(() => core.recordQuestionDetails(ledger, { questionId: q, by: LANE, ask: "Something else entirely?" }))).toContain("never replaced");
		expect(ledger.entries(wl).length).toBe(entries);
		expect(core.questionDetails(ledger, q)?.ask).toBe(ask);
	});

	test("an orchestrator question about no workload carries its name; one about a workload inherits that workload's", () => {
		const { ledger } = tempLedger();
		const wl = open(ledger, "Move the header offset into a token");
		ensureStandingWorkload(ledger);
		const raise = (input: { about: string | null; ask: string; name?: string }) => ledger.write(() => {
			const q = ledger.raiseQuestion({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)!.id, body: "Shall I go on?", options: ["yes", "no"] });
			if (input.about) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: questionSubjectBody(q, input.about) });
			core.recordQuestionDetails(ledger, { questionId: q, by: SURFACE_BY, ask: input.ask, name: input.name });
			return q;
		});
		const before = ledger.questions(STANDING_WORKLOAD_ID).length;
		expect(refusal(() => raise({ about: null, ask: "Should I renew the certificate now?" }))).toContain("needs a name");
		expect(refusal(() => raise({ about: wl, ask: "Should the lane go on?", name: "Feed header offset" }))).toContain("takes that workload's name");
		expect(ledger.questions(STANDING_WORKLOAD_ID).length).toBe(before);
		const unbound = raise({ about: null, ask: "Should I renew the certificate now?", name: "Certificate renewal" });
		const bound = raise({ about: wl, ask: "Should the lane go on?" });
		expect(core.questionDetails(ledger, unbound)).toMatchObject({ ask: "Should I renew the certificate now?", name: "Certificate renewal" });
		expect(core.questionDetails(ledger, bound)).toEqual({ ask: "Should the lane go on?", sourceHash: askHash(ledger, bound, wl), entryId: expect.stringMatching(/^en-/) });
		expect([core.boundWorkload(ledger, ledger.question(unbound)!), core.boundWorkload(ledger, ledger.question(bound)!)]).toEqual([null, wl]);
	});
});

describe("importing reviewed descriptions", () => {
	test("fills the submitted gaps and reports a target opened after the manifest without refusing", () => {
		const { ledger } = tempLedger();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		const qa = laneQuestion(ledger, a);
		const manifest = {
			by: SURFACE_BY,
			workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }, { id: b, sourceHash: workHash(ledger, b), name: "Certificate renewal" }],
			questions: [{ id: qa, sourceHash: askHash(ledger, qa), ask: "Should the header offset become the left token or the right one?" }],
		};
		const c = open(ledger, "Opened after the manifest was reviewed");
		expect(core.importPendingDescriptions(ledger, manifest)).toEqual({ filled: [a, b, qa], skipped: [], missing: [c] });
		expect([core.workName(ledger, a)?.name, core.workName(ledger, b)?.name, core.questionDetails(ledger, qa)?.ask])
			.toEqual(["Feed header offset", "Certificate renewal", "Should the header offset become the left token or the right one?"]);
	});

	test("a changed live source refuses the whole submitted set; closed and gone targets are skipped", () => {
		const { ledger } = tempLedger();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		const closed = open(ledger, "Finished earlier");
		ledger.closeWorkload(closed, { by: SURFACE_BY });
		const answered = laneQuestion(ledger, a, "Answered already?");
		ledger.answerQuestion(answered, { by: SURFACE_BY, answer: "left", author: "jo", channel: "surface" });
		const entries = () => [a, b].map((w) => ledger.entries(w).length);
		const before = entries();
		const stale = core.workSourceHash({ id: b, brief: "Renew the certificate before Friday" });
		const refused = refusal(() => core.importPendingDescriptions(ledger, {
			by: SURFACE_BY,
			workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }, { id: b, sourceHash: stale, name: "Certificate renewal" }],
			questions: [],
		}));
		expect(refused).toContain(`${b}: its source changed`);
		expect(entries()).toEqual(before);
		expect(core.workName(ledger, a)).toBeNull();
		const gone = "wl-mv0000000gone00";
		const result = core.importPendingDescriptions(ledger, {
			by: SURFACE_BY,
			workloads: [{ id: closed, sourceHash: "c".repeat(64), name: "Finished work" }, { id: gone, sourceHash: "d".repeat(64), name: "Gone work" }, { id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }],
			questions: [{ id: answered, sourceHash: askHash(ledger, answered), ask: "Was it answered already?" }],
		});
		expect(result).toEqual({ filled: [a], skipped: [closed, gone, answered], missing: [b] });
	});

	test("never overwrites: a described target is skipped, not relabelled; only the surface imports; an invalid value refuses all", () => {
		const { ledger } = tempLedger();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		core.recordWorkName(ledger, { workloadId: a, by: SURFACE_BY, name: "Feed header offset" });
		const entries = () => [a, b].map((w) => ledger.entries(w).length);
		const before = entries();
		const good = { id: b, sourceHash: workHash(ledger, b), name: "Certificate renewal" };
		expect(refusal(() => core.importPendingDescriptions(ledger, { by: LANE, workloads: [good], questions: [] }))).toContain("only the orchestrator surface");
		expect(refusal(() => core.importPendingDescriptions(ledger, { by: SURFACE_BY, workloads: [good, { id: a, sourceHash: workHash(ledger, a), name: "Feed\u2028offset" }], questions: [] }))).toContain("U+2028");
		expect(refusal(() => core.importPendingDescriptions(ledger, { by: SURFACE_BY, workloads: [good, { id: STANDING_WORKLOAD_ID, sourceHash: "e".repeat(64), name: "Mine now" }], questions: [] }))).toContain("fixed name");
		expect(entries()).toEqual(before);
		const result = core.importPendingDescriptions(ledger, { by: SURFACE_BY, workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Header token work" }, good], questions: [] });
		expect(result).toEqual({ filled: [b], skipped: [a], missing: [] });
		expect(core.workName(ledger, a)?.name).toBe("Feed header offset");
	});
});
