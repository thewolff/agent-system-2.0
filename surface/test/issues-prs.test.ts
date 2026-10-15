// The PR set and the open-PR scan (PLAN wl-mv66ylim0gahog § 2 prs.ts, § 5, § 9.2): every bound
// branch through `gh pr list --state all -L 1000`, then each test-requested PR none listed through
// `gh pr view`; a full branch list or any failure makes the set unknown. gh is stubbed through exec.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TEST_RUNNER_BY } from "../../ledger/src/index";
import { GitHub } from "../src/issues/github";
import { prSources, readPrSet, SCAN_LIMIT, scanOpenPrs } from "../src/issues/prs";
import { Sidecar } from "../src/issues/sidecar";
import { pushDestBody, testRequestedBody } from "../src/test-run";
import type { ExecResult } from "../src/types";
import { tempLedger, tmp } from "./helpers";

const REPO = "thewolff/agent-system-2.0";
const SHA = "a".repeat(40);
const ok = (v: unknown): ExecResult => ({ stdout: JSON.stringify(v), stderr: "", code: 0, killed: false });
const pr = (number: number, state = "MERGED", base = "main") => ({ number, state, url: `https://github.com/${REPO}/pull/${number}`, baseRefName: base });
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1];

function caller(answer: (args: string[]) => ExecResult) {
	const sidecar = Sidecar.open(join(tmp("issues-prs"), "issues.db"));
	sidecar.claim("h", 1_000);
	const calls: string[][] = [];
	const gh = new GitHub(async (_c, args) => {
		calls.push(args);
		return answer(args);
	}, sidecar, { holder: "h", perTick: 50, perHour: 300, now: () => 1_000 });
	return { gh, calls };
}

/** A workload with a holder that recorded a push-dest branch and a test-requested PR by number. */
function workload() {
	const { ledger } = tempLedger();
	const wl = ledger.openWorkload({ by: "lane-a", brief: "w", stakes: "normal", mode: "autonomous" });
	const sl = ledger.addSlice({ by: "lane-a", workloadId: wl, task: "t", doneCondition: "d", inputs: "i" });
	ledger.claimWorkload(wl, { by: "lane-x-1", holder: "lane-x-1", leaseMs: null });
	ledger.recordEntry({ by: "lane-x-1", workloadId: wl, kind: "assumption", body: pushDestBody({ remote: "origin", branch: "feature/side", sha: SHA }) });
	ledger.recordEntry({ by: TEST_RUNNER_BY, workloadId: wl, kind: "assumption", body: testRequestedBody({ runId: "tr-abc1234", pr: 77, sha: SHA, slice: sl, by: "lane-x-1" }) });
	return { ledger, wl };
}

describe("prSources", () => {
	test("wl/<id> plus every push-dest branch a holder wrote, and the test-requested PR numbers", () => {
		const { ledger, wl } = workload();
		expect(prSources(ledger, wl)).toEqual({ branches: [`wl/${wl}`, "feature/side"], requested: [77] });
	});
});

describe("readPrSet", () => {
	test("each branch is listed with --state all -L 1000; a merged PR beyond the first 30 of its branch still counts; a test-requested PR no list showed is fetched by number", async () => {
		const { ledger, wl } = workload();
		const many = Array.from({ length: 40 }, (_, i) => pr(100 + i, i === 35 ? "MERGED" : "CLOSED"));
		const { gh, calls } = caller((args) => {
			if (args[1] === "list" && arg(args, "--head") === `wl/${wl}`) return ok(many);
			if (args[1] === "list") return ok([pr(9, "OPEN")]);
			if (args[1] === "view") return ok(pr(77, "OPEN"));
			throw new Error(`unexpected ${args.join(" ")}`);
		});
		const set = await readPrSet(gh, REPO, prSources(ledger, wl));
		expect(set.known).toBe(true);
		if (!set.known) return;
		expect(set.prs.map((p) => p.number)).toEqual([9, 77, ...many.map((p) => p.number)]);
		expect(set.prs.find((p) => p.number === 135)?.state).toBe("MERGED");
		expect(calls[0]).toEqual(["pr", "list", "-R", REPO, "--head", `wl/${wl}`, "--state", "all", "-L", "1000", "--json", "number,state,url,baseRefName"]);
		expect(calls[1]![5]).toBe("feature/side");
		expect(calls[2]).toEqual(["pr", "view", "77", "-R", REPO, "--json", "number,state,url,baseRefName"]);
		expect(calls).toHaveLength(3);
	});

	test("a test-requested PR a branch list already showed is not fetched again", async () => {
		const { ledger, wl } = workload();
		const { gh, calls } = caller((args) => ok(arg(args, "--head") === "feature/side" ? [pr(77, "OPEN")] : []));
		const set = await readPrSet(gh, REPO, prSources(ledger, wl));
		expect(set).toEqual({ known: true, prs: [{ number: 77, state: "OPEN", url: `https://github.com/${REPO}/pull/77`, base: "main" }] });
		expect(calls.every((c) => c[1] === "list")).toBe(true);
	});

	test("a 1000-row branch list makes the set unknown", async () => {
		const { ledger, wl } = workload();
		const { gh } = caller(() => ok(Array.from({ length: 1000 }, (_, i) => pr(i + 1, "CLOSED"))));
		const set = await readPrSet(gh, REPO, prSources(ledger, wl));
		expect(set.known).toBe(false);
		if (!set.known) expect(set.why).toContain("1000 rows");
	});

	test("a failing list or view call, or a malformed record, makes the set unknown", async () => {
		const { ledger, wl } = workload();
		const fail = caller(() => ({ stdout: "", stderr: "HTTP 502: bad gateway", code: 1, killed: false }));
		expect(await readPrSet(fail.gh, REPO, prSources(ledger, wl))).toEqual({ known: false, why: "gh pr list exited 1: HTTP 502: bad gateway" });
		const view = caller((args) => (args[1] === "view" ? { stdout: "", stderr: "", code: 0, killed: true } : ok([])));
		expect((await readPrSet(view.gh, REPO, prSources(ledger, wl))).known).toBe(false);
		const bad = caller(() => ok([{ number: 3 }]));
		expect((await readPrSet(bad.gh, REPO, prSources(ledger, wl))).known).toBe(false);
	});
});

describe("scanOpenPrs", () => {
	test("one counted call for every open PR in the repo, with head, base, fork flag and body", async () => {
		const { gh, calls } = caller(() =>
			ok([{ number: 4, url: "u4", headRefName: "wl/x", baseRefName: "main", isCrossRepository: false, body: "b" }, { number: 5, url: "u5", headRefName: "f", baseRefName: "main", isCrossRepository: true, body: "" }]),
		);
		const s = await scanOpenPrs(gh, REPO);
		expect(s).toEqual({
			ok: true,
			truncated: false,
			prs: [
				{ number: 4, url: "u4", head: "wl/x", base: "main", crossRepository: false, body: "b" },
				{ number: 5, url: "u5", head: "f", base: "main", crossRepository: true, body: "" },
			],
		});
		expect(calls).toEqual([["pr", "list", "-R", REPO, "--state", "open", "-L", "200", "--json", "number,url,headRefName,baseRefName,isCrossRepository,body"]]);
		expect(gh.calls).toBe(1);
	});

	test("200 rows back is truncated; a failure is reported, never thrown", async () => {
		const full = caller(() => ok(Array.from({ length: SCAN_LIMIT }, (_, i) => ({ number: i + 1, url: `u${i}`, headRefName: `h${i}`, baseRefName: "main", isCrossRepository: false, body: "" }))));
		expect(await scanOpenPrs(full.gh, REPO)).toMatchObject({ ok: true, truncated: true });
		const down = caller(() => ({ stdout: "", stderr: "connect: network is unreachable", code: 1, killed: false }));
		expect(await scanOpenPrs(down.gh, REPO)).toEqual({ ok: false, error: "gh pr list exited 1: connect: network is unreachable" });
	});
});
