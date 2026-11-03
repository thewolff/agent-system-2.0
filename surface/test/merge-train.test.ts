// The merge rule (PLAN wl-mvqwn80onq9hq8 D11, R27): `prStakes` reads a production workload's PR as `normal`, so the train
// merges it itself with no question to Jo, once its plan is approved and its newest review passed; Jo's halt and the plan
// auto-start's hold still hold it; anything short of that stays `production`, Jo's question. `trainFixStakes` keeps a fix
// workload for a production PR at production. Every case runs on a real temp ledger with a temp git checkout whose origin is
// a fake GitHub URL.
import { describe, expect, test } from "bun:test";
import { reviewLoopEndBody, reviewRoundBody, UNKNOWN } from "../../classifier/src/rounds";
import { LANE_STARTER_BY, type Ledger } from "../../ledger/src/index";
import { recordRepo } from "../src/decision-log";
import { planApprovedBody, planAutoApprovedBody, planAutoStartNoticeBody, planFirstBody, planHaltedBody } from "../src/launch";
import { prStakes, prStakesLine, type StakesView, trainFixStakes } from "../src/merge-train";
import { sendNotice } from "../src/notice";
import { ESCALATION_BY, SURFACE_BY } from "../src/types";
import { clock, tempLedger, tmp } from "./helpers";

const REPO = "thewolff/product";

/** A git checkout at a temp path whose origin is REPO's GitHub URL. */
function checkout(): string {
	const dir = tmp("merge-rule-repo");
	for (const args of [["init", "-q"], ["config", "remote.origin.url", `https://github.com/${REPO}.git`]]) {
		const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${dir} exited ${r.exitCode}: ${r.stderr.toString()}`);
	}
	return dir;
}

interface Opts {
	stakes?: "throwaway" | "normal" | "production";
	/** The plan rows the surface wrote: `plan: first production` then `plan: approved`, the first alone, or none. */
	plan?: "approved" | "pending" | "none";
	/** The review on the change slice: a round then its end, a passed end then a fresh round, or none. */
	review?: "pass" | "stop" | "reopened" | "none";
}

let seq = 0;
/** Workload W on REPO's checkout, held by a lane, with its plan rows and its change slice's review; returns W and the PR view of `wl/<W>`. */
function workload(ledger: Ledger, o: Opts = {}): { wl: string; view: StakesView } {
	const holder = `lane-p-${++seq}`;
	const wl = ledger.openWorkload({ by: SURFACE_BY, brief: "Ship the billing header", stakes: o.stakes ?? "production", mode: "autonomous" });
	recordRepo(ledger, wl, checkout());
	const plan = o.plan ?? "approved";
	if (plan !== "none") ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("production") });
	if (plan === "approved") ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planApprovedBody(`in-approve-${seq}`) });
	expect(ledger.claimWorkload(wl, { by: LANE_STARTER_BY, holder, leaseMs: 600_000 }).won).toBe(true);
	const sl = ledger.addSlice({ by: holder, workloadId: wl, task: "change", doneCondition: "tests pass", inputs: "src" });
	const round = () => ledger.recordEntry({
		by: holder, workloadId: wl, sliceId: sl, kind: "assumption",
		body: reviewRoundBody({ slice: sl, round: 1, token: `dt-${seq}`, group: `dg-${seq}`, verdict: "accepted", findings: UNKNOWN }),
	});
	const review = o.review ?? "pass";
	if (review !== "none") round();
	if (review === "pass" || review === "reopened") ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLoopEndBody(sl, "pass") });
	if (review === "stop") ledger.recordEntry({ by: holder, workloadId: wl, sliceId: sl, kind: "assumption", body: reviewLoopEndBody(sl, "stop") });
	if (review === "reopened") round();
	const view: StakesView = { number: 140, headRefName: `wl/${wl}`, isCrossRepository: false, headRepository: { name: "product" }, headRepositoryOwner: { login: "thewolff" } };
	return { wl, view };
}

describe("R27: a green, reviewed production PR reads normal, so the train merges it with no question to Jo", () => {
	test("plan approved and newest review passed: normal, the line the stakes script prints and the train merges on", () => {
		const { ledger } = tempLedger();
		const { wl, view } = workload(ledger);
		const s = prStakes(view, REPO, ledger);
		expect(s).toEqual({ stakes: "normal", reason: `${wl} on ${REPO}, stakes production, plan approved and review passed` });
		expect(prStakesLine(s)).toBe("normal");
	});

	test("anything short of an approved plan and a passed newest review stays production, Jo's question, with its reason", () => {
		const { ledger } = tempLedger();
		const cases: [string, Opts, string][] = [
			["no plan: line", { plan: "none" }, "it has no approved plan (no plan: approved entry)"],
			["plan pending", { plan: "pending" }, "its plan is not approved (plan: first production)"],
			["no review", { review: "none" }, "has no review on any slice"],
			["review stopped", { review: "stop" }, "ended stop, not pass or accept"],
			["review reopened after its pass", { review: "reopened" }, "was dispatched after its loop ended pass and has not settled"],
		];
		for (const [name, o, reason] of cases) {
			const { wl, view } = workload(ledger, o);
			const s = prStakes(view, REPO, ledger);
			expect({ name, stakes: s.stakes }).toEqual({ name, stakes: "production" });
			expect({ name, reason: s.reason }).toEqual({ name, reason: expect.stringContaining(`${wl}'s stakes are production and `) });
			expect({ name, reason: s.reason }).toEqual({ name, reason: expect.stringContaining(reason) });
		}
		// throwaway never reads normal on a train
		const t = workload(ledger, { stakes: "throwaway" });
		expect(prStakes(t.view, REPO, ledger)).toEqual({ stakes: "production", reason: `${t.wl}'s stakes are throwaway` });
	});

	test("Jo's halt holds a green, reviewed production PR until jo; a later approve releases it to the train", () => {
		const { ledger } = tempLedger();
		const { wl, view } = workload(ledger);
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planHaltedBody("in-halt") });
		expect(prStakes(view, REPO, ledger)).toMatchObject({ stakes: "hold", until: "jo", reason: expect.stringContaining("halted by Jo") });
		ledger.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planApprovedBody("in-again") });
		expect(prStakes(view, REPO, ledger).stakes).toBe("normal");
	});

	test("the plan auto-start's hold holds a green, reviewed production PR until jo while its notice is undelivered", () => {
		const c = clock();
		const { ledger } = tempLedger(c.now);
		const { wl, view } = workload(ledger, { plan: "pending" });
		ledger.recordEntry({ by: ESCALATION_BY, workloadId: wl, kind: "assumption", body: planAutoApprovedBody("dg-1") });
		sendNotice(ledger, { by: ESCALATION_BY, workloadId: wl, body: planAutoStartNoticeBody(wl, "/plans/PLAN.md") });
		expect(prStakes(view, REPO, ledger)).toMatchObject({ stakes: "hold", until: "jo", reason: expect.stringContaining("started without Jo's approve") });
	});
});

describe("trainFixStakes: a train-fix workload opens at its PR workload's own stakes (D11)", () => {
	test("production for a production PR even when prStakes reads it normal; normal for a normal one; production for throwaway and a fork", () => {
		const { ledger } = tempLedger();
		const prod = workload(ledger);
		expect(prStakes(prod.view, REPO, ledger).stakes).toBe("normal");
		expect(trainFixStakes(prod.view, REPO, ledger)).toBe("production");
		expect(trainFixStakes(workload(ledger, { stakes: "normal" }).view, REPO, ledger)).toBe("normal");
		expect(trainFixStakes(workload(ledger, { stakes: "throwaway" }).view, REPO, ledger)).toBe("production");
		expect(trainFixStakes({ ...prod.view, isCrossRepository: true }, REPO, ledger)).toBe("production");
	});
});
