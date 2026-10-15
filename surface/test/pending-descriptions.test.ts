// The pending-description backfill (PLAN wl-mv7gidggnlkem8 § Backfill and deployment): the
// orchestrator's registered `orchestrator_describe_pending` tool applies a reviewed manifest file named
// by path and SHA-256, missing-only and atomically, behind the role and wake-read guards; the read-only
// script exports the gaps pending still shows and checks coverage and reviewed-value equality. Every
// ledger here is a scratch file; the script reads it through the normal ledger env.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLimitBody } from "../../classifier/src/rounds";
import type { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import * as ext from "../extensions/pending-descriptions";
import * as script from "../scripts/pending-descriptions";
import { ensureStandingWorkload, standingSlice } from "../src/identity";
import { planFirstBody, planQuestionBody } from "../src/launch";
import { questionSubjectBody } from "../src/orchestrator-question";
import { pendingItems } from "../src/pending";
import { importPendingDescriptions, questionDetails, questionSourceHash, workName, workSourceHash } from "../src/pending-details";
import { promptWaitBody } from "../src/signals";
import { ORCHESTRATOR_RECIPIENT, STANDING_WORKLOAD_ID, SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, tempLedger, tmp } from "./helpers";

const TOOL = "orchestrator_describe_pending";
const LANE = "lane-t-1";
const SCRIPT = join(import.meta.dir, "..", "scripts", "pending-descriptions.ts");

/** A scratch ledger whose clock moves one second per stamp, so in-flight order is creation order. */
function ticking(): { ledger: Ledger; path: string } {
	let n = 0;
	return tempLedger(() => new Date(Date.UTC(2026, 9, 1, 10) + n++ * 1000).toISOString());
}

const open = (ledger: Ledger, brief: string): string => ledger.openWorkload({ by: SURFACE_BY, brief, stakes: "normal", mode: "autonomous" });

/** A lane's slice on `wl` and its open question, with no details. */
function laneQuestion(ledger: Ledger, wl: string, options = ["left", "right"], body = "Left or right?"): { sl: string; q: string } {
	const sl = ledger.addSlice({ by: LANE, workloadId: wl, task: "Pick the token", doneCondition: "d", inputs: "i" });
	return { sl, q: ledger.raiseQuestion({ by: LANE, workloadId: wl, sliceId: sl, body, options }) };
}

/** An orchestrator question on the standing slice, about `about` or nothing, with no details. */
function orchestratorQuestion(ledger: Ledger, about: string | null): string {
	ensureStandingWorkload(ledger);
	return ledger.write(() => {
		const q = ledger.raiseQuestion({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, sliceId: standingSlice(ledger)!.id, body: "Shall I go on?", options: ["yes", "no"] });
		if (about) ledger.recordEntry({ by: SURFACE_BY, workloadId: STANDING_WORKLOAD_ID, kind: "assumption", body: questionSubjectBody(q, about) });
		return q;
	});
}

const askHash = (ledger: Ledger, q: string, subject: string | null = null): string => questionSourceHash(ledger.question(q)!, subject);
const workHash = (ledger: Ledger, wl: string): string => workSourceHash(ledger.workload(wl)!);

/** The manifest written to a scratch file, and the SHA-256 of its exact bytes. */
function manifestFile(value: unknown, raw?: string): { path: string; sha256: string } {
	const path = join(tmp("manifest"), "manifest.json");
	const bytes = raw ?? `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(path, bytes);
	return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

/** Every entry on every workload, as a count: what an import that writes nothing leaves unchanged. */
const entryCount = (ledger: Ledger): number => ledger.inFlight().reduce((n, f) => n + ledger.entries(f.workload.id).length, 0);

/** The surface over `db` as a fresh orchestrator process loads it, with its wake taken and (unless `owe`) read. */
async function surface(db: string, role = "orchestrator") {
	const voice = join(tmp("voice"), "VOICE.md");
	writeFileSync(voice, "VOICE DOC BODY");
	const f = fakePi();
	orchestratorSurface(f.pi, { AGENT_SYSTEM_ROLE: role, AGENT_SYSTEM_LEDGER_DB: db, AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home" }, {});
	const ctx = ctxOf();
	const call = async (name: string, params: Record<string, unknown>) => (await f.tool(name).execute("1", params, undefined, undefined, ctx)) as { content: { text: string }[]; details?: Record<string, unknown> };
	const wake = async () => {
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: ["base"] }, ctx);
	};
	return { f, call, wake, describe: (params: Record<string, unknown>) => call(TOOL, params) };
}

describe("orchestrator_describe_pending", () => {
	test("is refused until the wake is read, applies only the reviewed bytes, fills gaps missing-only and reports the delta", async () => {
		const { ledger, path: db } = ticking();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		const { q: qa } = laneQuestion(ledger, a);
		const reviewed = {
			workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }],
			questions: [{ id: qa, sourceHash: askHash(ledger, qa), ask: "Should the header offset become the left token or the right one?" }],
		};
		const m = manifestFile(reviewed);
		const s = await surface(db);
		await s.wake();
		const before = entryCount(ledger);

		const owed = await s.describe({ manifestPath: m.path, sha256: m.sha256 });
		expect(owed.content[0]!.text).toContain("orchestrator_wake_read");
		expect([workName(ledger, a), entryCount(ledger)]).toEqual([null, before]);
		await s.call("orchestrator_wake_read", { body: "resuming the backfill" });
		const afterWake = entryCount(ledger);

		// Only the reviewed bytes: another digest, the same path after one byte changed, or a relative path writes nothing.
		expect((await s.describe({ manifestPath: m.path, sha256: "0".repeat(64) })).content[0]!.text).toContain(`not the reviewed ${"0".repeat(64)}`);
		writeFileSync(m.path, `${readFileSync(m.path, "utf8")} `);
		expect((await s.describe({ manifestPath: m.path, sha256: m.sha256 })).content[0]!.text).toContain("not the reviewed");
		expect((await s.describe({ manifestPath: "manifest.json", sha256: m.sha256 })).content[0]!.text).toContain("must be absolute");
		expect([workName(ledger, a), questionDetails(ledger, qa), entryCount(ledger)]).toEqual([null, null, afterWake]);

		const c = open(ledger, "Opened after the manifest was reviewed");
		const good = manifestFile(reviewed);
		const applied = await s.describe({ manifestPath: good.path, sha256: good.sha256 });
		expect(applied.details).toMatchObject({ filled: [a, qa], skipped: [], missing: [b, c], unfillable: [] });
		expect(applied.content[0]!.text).toContain(`${b}, ${c}`);
		expect([workName(ledger, a)?.name, questionDetails(ledger, qa)?.ask]).toEqual(["Feed header offset", "Should the header offset become the left token or the right one?"]);

		// Missing-only: a second manifest naming the same targets differently relabels nothing.
		const other = manifestFile({ workloads: [{ ...reviewed.workloads[0], name: "Something else" }], questions: [{ ...reviewed.questions[0], ask: "Something else entirely?" }] });
		const again = await s.describe({ manifestPath: other.path, sha256: other.sha256 });
		expect(again.details).toMatchObject({ filled: [], skipped: [a, qa] });
		expect([workName(ledger, a)?.name, questionDetails(ledger, qa)?.ask]).toEqual(["Feed header offset", "Should the header offset become the left token or the right one?"]);
	});

	test("a live target whose source changed, or a manifest of the wrong shape, refuses the whole file and writes nothing", async () => {
		const { ledger, path: db } = ticking();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		const s = await surface(db);
		const before = entryCount(ledger);
		const name = (id: string, n: string, hash = workHash(ledger, id)) => ({ id, sourceHash: hash, name: n });
		const refused = [
			{ workloads: [name(a, "Feed header offset"), name(b, "Certificate renewal", "e".repeat(64))], questions: [] },
			{ workloads: [name(a, "Feed header offset")], questions: [], extra: true },
			{ workloads: [{ ...name(a, "Feed header offset"), note: "x" }], questions: [] },
			{ workloads: [name(a, "Feed\nheader")], questions: [] },
			{ workloads: [name(a, "Feed header offset"), name(a, "Feed header offset")], questions: [] },
			{ workloads: [name(a, "Feed header offset", "E".repeat(64))], questions: [] },
			{ workloads: Array.from({ length: ext.MANIFEST_MAX_ENTRIES + 1 }, () => name(a, "Feed header offset")), questions: [] },
			{ workloads: [name(a, "Feed header offset")] },
		];
		for (const value of refused) {
			const m = manifestFile(value);
			const r = await s.describe({ manifestPath: m.path, sha256: m.sha256 });
			expect({ value: JSON.stringify(value).slice(0, 120), text: r.content[0]!.text }).toEqual({ value: JSON.stringify(value).slice(0, 120), text: expect.stringMatching(/nothing was written/i) });
		}
		const notJson = manifestFile(null, "{ not json");
		expect((await s.describe({ manifestPath: notJson.path, sha256: notJson.sha256 })).content[0]!.text).toContain("not UTF-8 JSON");
		expect([workName(ledger, a), workName(ledger, b), entryCount(ledger)]).toEqual([null, null, before]);
	});

	test("does nothing on a session that is not the orchestrator surface", async () => {
		const { ledger, path: db } = ticking();
		const a = open(ledger, "Move the header offset into a token");
		const m = manifestFile({ workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }], questions: [] });
		const lane = await surface(db, "lane");
		expect((await lane.describe({ manifestPath: m.path, sha256: m.sha256 })).content[0]!.text).toContain("not the orchestrator surface");
		expect(workName(ledger, a)).toBeNull();
	});
});

describe("pending coverage", () => {
	test("covers exactly the gaps pending's rows report: a machine question its phrase map covers needs no ask; any other option, a lookalike, reserved, wait and about work do", () => {
		const { ledger } = ticking();
		// plan: plan-first, the holder's plan-question entry in the raising write
		const plan = open(ledger, "Plan the header work");
		ledger.recordEntry({ by: SURFACE_BY, workloadId: plan, kind: "assumption", body: planFirstBody("your word") });
		expect(ledger.claimWorkload(plan, { by: LANE, holder: LANE, leaseMs: null }).won).toBe(true);
		// each plan question on its own slice: a raised question pauses its slice
		const raisePlan = (options: string[]) => ledger.write(() => {
			const planSlice = ledger.addSlice({ by: LANE, workloadId: plan, task: "plan", doneCondition: "d", inputs: "i" });
			const q = ledger.raiseQuestion({ by: LANE, workloadId: plan, sliceId: planSlice, body: "/tmp/plan/PLAN.md\n- sl-a: x", options });
			ledger.recordEntry({ by: LANE, workloadId: plan, sliceId: planSlice, kind: "assumption", body: planQuestionBody(q) });
			return q;
		});
		const planKnown = raisePlan(["approve", "revise", "cancel"]);
		const planExtra = raisePlan(["approve", "revise", "defer"]);
		const planCased = raisePlan(["Approve", "Revise", "Cancel"]);
		// ceiling: the runner's question on its own sl-ceiling- slice
		const ceil = open(ledger, "Spend watch");
		const ceilSlice = ledger.addSlice({ by: "lane-runner", workloadId: ceil, task: "ceiling", doneCondition: "d", inputs: "i", id: "sl-ceiling-1" });
		const ceiling = ledger.raiseQuestion({ by: "lane-runner", workloadId: ceil, sliceId: ceilSlice, body: "spend at 80 %", options: ["stop", "extend", "split"] });
		// review-limit and park, each named by its own entry; a lookalike with park options but no entry
		const review = open(ledger, "Review loop");
		const { sl: rSlice, q: limit } = laneQuestion(ledger, review, ["extend", "accept", "stop"], "rounds used");
		ledger.recordEntry({ by: LANE, workloadId: review, sliceId: rSlice, kind: "assumption", body: reviewLimitBody(limit, rSlice) });
		const { sl: pSlice, q: park } = laneQuestion(ledger, review, ["same-lab", "wait"], "no other lab");
		ledger.recordEntry({ by: "classifier", workloadId: review, sliceId: pSlice, kind: "assumption", body: `review-park: ${park} slice ${pSlice}` });
		const { q: lookalike } = laneQuestion(ledger, review, ["same-lab", "wait"], "same lab or wait?");
		// reserved request, prompt wait, orchestrator questions about work and about nothing
		const reserved = open(ledger, "Push the release");
		const en = ledger.recordEntry({ by: "lane-r", workloadId: reserved, kind: "reserved-request", body: "push main" });
		const waiting = open(ledger, "Waits on a prompt");
		ledger.enqueue({ by: "lane-w", workloadId: waiting, sender: "lane-w", recipient: ORCHESTRATOR_RECIPIENT, body: promptWaitBody("ask", "c7", "s1", "ask: which branch?") });
		const about = open(ledger, "The subject of an orchestrator question");
		const aboutQ = orchestratorQuestion(ledger, about);
		const unboundQ = orchestratorQuestion(ledger, null);
		const gone = open(ledger, "Closed since it was asked about");
		const goneQ = orchestratorQuestion(ledger, gone);
		ledger.closeWorkload(gone, { by: SURFACE_BY });

		const c = ext.pendingCoverage(ledger);
		expect(c.missing).toEqual([plan, planExtra, ceil, review, lookalike, reserved, waiting, about, aboutQ, unboundQ, goneQ]);
		expect(c.unfillable).toEqual([gone]);
		expect(c.missing).not.toContain(STANDING_WORKLOAD_ID);
		const q = (id: string) => c.questions.find((x) => x.id === id)!;
		expect([planKnown, planExtra, planCased, ceiling, limit, park, lookalike].map((id) => [q(id).shownAsk !== null, q(id).needsAsk])).toEqual([
			[true, false], [false, true], [true, false], [true, false], [true, false], [true, false], [false, true],
		]);
		// Every gap a pending row shows is one coverage reports, fillable or not.
		const shownGaps = new Set(pendingItems(ledger).flatMap((i) => i.missing.map((g) => g.id)));
		expect([...shownGaps].filter((id) => !c.missing.includes(id) && !c.unfillable.includes(id))).toEqual([]);
		const shown = (id: string) => c.workloads.find((w) => w.id === id)!.shownBy;
		expect([shown(reserved), shown(waiting), shown(about)]).toEqual([[en], ["wait lane-w ask"], [aboutQ]]);

		// The export is exactly the fillable gaps; only the unbound question carries a name slot.
		const skeleton = ext.exportSkeleton(c);
		expect(skeleton.workloads.map((w) => w.id)).toEqual([plan, ceil, review, reserved, waiting, about]);
		expect(skeleton.questions).toEqual([
			{ id: planExtra, sourceHash: askHash(ledger, planExtra), ask: "" },
			{ id: lookalike, sourceHash: askHash(ledger, lookalike), ask: "" },
			{ id: aboutQ, sourceHash: askHash(ledger, aboutQ, about), ask: "" },
			{ id: unboundQ, sourceHash: askHash(ledger, unboundQ), ask: "", name: "" },
			{ id: goneQ, sourceHash: askHash(ledger, goneQ, gone), ask: "" },
		]);
	});
});

describe("the read-only script", () => {
	/** Run the script in-process against the ledger at `db`, as the normal ledger env names it. */
	const run = (db: string, ...argv: string[]) => {
		let out = "";
		let err = "";
		const code = script.main(argv, { ...process.env, AGENT_SYSTEM_LEDGER_DB: db }, (s) => (out += s), (s) => (err += s));
		return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> & { manifest?: Record<string, unknown> } };
	};

	test("export lists the gaps, check proves coverage and reviewed-value equality separately, and nothing is written", () => {
		const { ledger, path: db } = ticking();
		const a = open(ledger, "Move the header offset into a token");
		const b = open(ledger, "Renew the certificate");
		const { q: qa } = laneQuestion(ledger, a);
		const files = () => [db, `${db}-wal`].filter(existsSync).map((p) => createHash("sha256").update(readFileSync(p)).digest("hex"));
		const before = files();

		const exported = run(db, "export");
		expect(exported.code).toBe(0);
		expect(exported.json()).toEqual({
			workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "" }, { id: b, sourceHash: workHash(ledger, b), name: "" }],
			questions: [{ id: qa, sourceHash: askHash(ledger, qa), ask: "" }],
		});
		const snap = run(db, "snapshot").json() as unknown as { questions: { id: string; body: string; options: string[] }[] };
		expect(snap.questions).toMatchObject([{ id: qa, body: "Left or right?", options: ["left", "right"] }]);
		const bare = run(db, "check");
		expect([bare.code, bare.json().ok, bare.json().missing]).toEqual([1, false, [a, qa, b]]);
		expect(files()).toEqual(before);

		// Reviewed for a and qa; b is the delta. Before the apply both are unapplied, after it equal; b stays unsubmitted.
		const reviewed = {
			workloads: [{ id: a, sourceHash: workHash(ledger, a), name: "Feed header offset" }],
			questions: [{ id: qa, sourceHash: askHash(ledger, qa), ask: "Should the header offset become the left token or the right one?" }],
		};
		const m = manifestFile(reviewed);
		expect(run(db, "check", "--manifest", m.path, "--sha256", m.sha256).json().manifest).toMatchObject({ unapplied: [a, qa], equal: [], unsubmitted: [b] });
		importPendingDescriptions(ledger, { by: SURFACE_BY, ...reviewed });
		const partly = run(db, "check", "--manifest", m.path, "--sha256", m.sha256);
		expect([partly.code, partly.json().ok, partly.json().missing, partly.json().manifest]).toEqual([1, false, [b], expect.objectContaining({ equal: [a, qa], differ: [], unsubmitted: [b] })]);

		// Full coverage: b named by a different manifest. The first manifest is now ok; one whose value differs from the stored one is not.
		importPendingDescriptions(ledger, { by: SURFACE_BY, workloads: [{ id: b, sourceHash: workHash(ledger, b), name: "Certificate renewal" }], questions: [] });
		const covered = run(db, "check", "--manifest", m.path, "--sha256", m.sha256);
		expect([covered.code, covered.json().ok, covered.json().missing]).toEqual([0, true, []]);
		const wrong = manifestFile({ workloads: [{ id: b, sourceHash: workHash(ledger, b), name: "Cert renewal" }, { id: a, sourceHash: "e".repeat(64), name: "Feed header offset" }], questions: [] });
		const differs = run(db, "check", "--manifest", wrong.path, "--sha256", wrong.sha256);
		expect([differs.code, differs.json().ok, differs.json().manifest]).toEqual([1, false, expect.objectContaining({
			differ: [{ id: b, reviewed: { name: "Cert renewal" }, stored: { name: "Certificate renewal" } }], stale: [a],
		})]);

		// A digest that is not the file's, a manifest flag alone, or a stray argument: exit 2 before any read.
		expect(run(db, "check", "--manifest", m.path, "--sha256", "0".repeat(64)).code).toBe(2);
		expect(run(db, "check", "--manifest", m.path).code).toBe(2);
		expect(run(db, "export", "--apply").code).toBe(2);
		expect(run(db, "apply").code).toBe(2);
	});

	test("runs as a script against the ledger the env names", () => {
		const { ledger, path: db } = ticking();
		const a = open(ledger, "Move the header offset into a token");
		const r = Bun.spawnSync([process.execPath, SCRIPT, "check"], { env: { ...process.env, AGENT_SYSTEM_LEDGER_DB: db }, stdout: "pipe", stderr: "pipe" });
		expect([r.exitCode, JSON.parse(r.stdout.toString()).missing]).toEqual([1, [a]]);
	});
});
