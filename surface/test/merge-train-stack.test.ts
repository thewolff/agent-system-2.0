// Stacked PRs on the merge train (PLAN wl-mv8s8srodefytc § 1b): what a PR declares (`Depends-on:` body lines,
// a base branch that is another open PR's head), the train's order (Jo's order with no dependency; dependencies
// first; waiting, landed and cycle cases), the chain line, the base-branch edges no body line records yet, and
// the real `order` subcommand of surface/scripts/merge-train.ts with a fake gh on PATH.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyDeps, chainLine, headsByBranch, type OpenHead, orderReport, prDeps, type StackPr, trainOrder } from "../src/merge-train-stack";
import { tmp } from "./helpers";

const CLI = join(import.meta.dir, "..", "scripts", "merge-train.ts");
const REPO = "acme/widgets";

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const pr = (number: number, o: { body?: string; base?: string; state?: string } = {}): StackPr & { state: string } => ({
	number, body: o.body ?? "", baseRefName: o.base ?? "main", state: o.state ?? "OPEN",
});

/** An open PR as `gh pr list --json number,headRefName,isCrossRepository` lists it; `fork` for a fork's PR. */
const head = (number: number, headRefName: string, fork = false): OpenHead => ({ number, headRefName, isCrossRepository: fork });

/** `orderReport` over these PR views and open heads, as `order` computes it after its gh calls. */
function report(train: number[], views: (StackPr & { state: string })[], open: OpenHead[] = []) {
	return orderReport(train, new Map(views.map((v) => [v.number, v])), headsByBranch(open));
}

describe("declarations", () => {
	test("a body's Depends-on: lines (any case, # optional, commas or spaces, several lines) and a base branch another open PR heads are both parsed", () => {
		const body = "Stacks on the API.\r\n\nDepends-on: #101, #102\ndepends-on: 103 #101 (the store)\n  DEPENDS-ON:#104\nNot a Depends-on: #999 line\nDepends-on: none yet";
		expect(bodyDeps(body)).toEqual([101, 102, 103, 104]);
		const heads = headsByBranch([head(101, "wl/wl-api"), head(107, "plumb/x")]);
		expect(prDeps(pr(106, { base: "wl/wl-api" }), heads)).toEqual([101]);
		expect(prDeps(pr(106, { body: "Depends-on: #120", base: "wl/wl-api" }), heads)).toEqual([120, 101]);
		expect(prDeps(pr(106, { body: "Depends-on: #101", base: "wl/wl-api" }), heads)).toEqual([101]);
		expect(prDeps(pr(106), heads)).toEqual([]);
		expect(prDeps(pr(106, { base: "no/such-head" }), heads)).toEqual([]);
		expect(prDeps(pr(106, { body: "Depends-on: #106" }), heads)).toEqual([]);
	});

	test("an open-PR list longer than 30 still maps a head; a head two open PRs share, or main, maps to none", () => {
		const open = Array.from({ length: 40 }, (_, i) => head(200 + i, `plumb/b${i}`));
		const heads = headsByBranch([...open, head(300, "main"), head(301, "dup"), head(302, "dup")]);
		expect(heads.get("plumb/b35")).toBe(235);
		expect(prDeps(pr(106, { base: "plumb/b35" }), heads)).toEqual([235]);
		expect(heads.has("main")).toBe(false);
		expect(heads.has("dup")).toBe(false);
	});

	test("a fork PR whose head carries an in-repo base's name is no dependency: in-repo B on feature/x gets no edge to it", () => {
		const heads = headsByBranch([head(110, "feature/y"), head(111, "feature/z"), head(150, "feature/x", true)]);
		expect(heads.has("feature/x")).toBe(false);
		expect(prDeps(pr(111, { base: "feature/x" }), heads)).toEqual([]);
		const r = report([110, 111], [pr(110), pr(111, { base: "feature/x" })], [head(110, "feature/y"), head(111, "feature/z"), head(150, "feature/x", true)]);
		expect(r).toEqual({ order: [110, 111], waiting: {}, cycles: [], chain: "#110 · #111", unrecorded: [] });
	});

	test("an in-repo head a fork also carries still maps: forks are left out, so the head is not shared", () => {
		for (const open of [[head(101, "feature/x"), head(150, "feature/x", true)], [head(150, "feature/x", true), head(101, "feature/x")]]) {
			const heads = headsByBranch(open);
			expect(heads.get("feature/x")).toBe(101);
			expect(prDeps(pr(106, { base: "feature/x" }), heads)).toEqual([101]);
		}
	});
});

describe("trainOrder and chainLine", () => {
	test("no dependencies: the order is Jo's order exactly, the chain separates every PR", () => {
		const r = report([139, 101, 120, 106], [pr(139), pr(101), pr(120), pr(106)]);
		expect(r).toEqual({ order: [139, 101, 120, 106], waiting: {}, cycles: [], chain: "#139 · #101 · #120 · #106", unrecorded: [] });
	});

	test("`train 106 101` with 106 depending on 101: the order 101, 106 and the chain #101 → #106", () => {
		const r = report([106, 101], [pr(106, { body: "Depends-on: #101" }), pr(101)]);
		expect(r.order).toEqual([101, 106]);
		expect(r.chain).toBe("#101 → #106");
		expect(r.waiting).toEqual({});
	});

	test("a three-deep stack lands bottom first and keeps Jo's order around it; the PR at hand shows bold", () => {
		const deps: Record<number, number[]> = { 107: [106], 106: [101] };
		const t = trainOrder([107, 139, 106, 101], (n) => deps[n] ?? [], () => "OPEN");
		expect(t).toEqual({ order: [101, 106, 107, 139], waiting: new Map(), cycles: [] });
		expect(chainLine(t, (n) => deps[n] ?? [], () => "OPEN")).toBe("#101 → #106 → #107 · #139");
		expect(chainLine(t, (n) => deps[n] ?? [], () => "OPEN", 106)).toBe("#101 → **#106** → #107 · #139");
	});

	test("an off-train dependency that is not merged sends its PR, and a PR stacked on it, to waiting", () => {
		const r = report([120, 121, 139], [pr(120, { body: "Depends-on: #118" }), pr(121, { body: "Depends-on: #120" }), pr(139), pr(118)]);
		expect(r.order).toEqual([139]);
		expect(r.waiting).toEqual({ 120: [118], 121: [120] });
		expect(r.chain).toBe("#139 · #120 ⇠ #118 (not on the train) · #121 ⇠ #120 (waiting)");
	});

	test("an off-train dependency that is MERGED counts as landed: not waiting, shown ✓", () => {
		const r = report([106, 139], [pr(106, { body: "Depends-on: #101" }), pr(139), pr(101, { state: "MERGED" })]);
		expect(r.order).toEqual([106, 139]);
		expect(r.waiting).toEqual({});
		expect(r.chain).toBe("#101 ✓ → #106 · #139");
	});

	test("a two-PR cycle goes to cycles, a PR on it waits, the rest run", () => {
		const r = report([130, 139, 131, 132], [
			pr(130, { body: "Depends-on: #131" }), pr(131, { body: "Depends-on: #130" }), pr(132, { body: "Depends-on: #131" }), pr(139),
		]);
		expect(r.cycles).toEqual([[130, 131]]);
		expect(r.waiting).toEqual({ 132: [131] });
		expect(r.order).toEqual([139]);
		expect(r.chain).toBe("#139 · #132 ⇠ #131 (in a cycle) · #130 ⇄ #131 (cycle)");
	});

	test("a base-branch edge with no body line is in unrecorded, and orders like a body line; once the body names it, it is recorded", () => {
		const open = [head(101, "wl/wl-api"), head(106, "wl/wl-ui")];
		const r = report([106, 101], [pr(106, { base: "wl/wl-api" }), pr(101)], open);
		expect(r.unrecorded).toEqual([{ pr: 106, dependsOn: 101 }]);
		expect(r.order).toEqual([101, 106]);
		expect(r.chain).toBe("#101 → #106");
		expect(report([106, 101], [pr(106, { base: "wl/wl-api", body: "Depends-on: #101" }), pr(101)], open).unrecorded).toEqual([]);
	});
});

describe("the order script, with a fake gh", () => {
	const GH = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$dir/gh.log"
if [ "$1 $2" = "pr list" ]; then cat "$dir/open.json"; exit 0; fi
if [ "$1 $2" = "pr view" ] && [ -f "$dir/prs/$3.json" ]; then cat "$dir/prs/$3.json"; exit 0; fi
echo "no pull requests found" >&2
exit 1
`;
	function world(views: (StackPr & { state: string; headRefName: string })[], open: OpenHead[]) {
		const root = tmp("train-order");
		roots.push(root);
		mkdirSync(join(root, "bin"));
		mkdirSync(join(root, "prs"));
		writeFileSync(join(root, "bin", "gh"), GH);
		chmodSync(join(root, "bin", "gh"), 0o755);
		writeFileSync(join(root, "open.json"), JSON.stringify(open));
		for (const v of views) writeFileSync(join(root, "prs", `${v.number}.json`), JSON.stringify(v));
		const run = (...args: string[]) => {
			const r = Bun.spawnSync([process.execPath, CLI, ...args], {
				cwd: root, stdout: "pipe", stderr: "pipe", env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root },
			});
			return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
		};
		return { run, calls: () => readFileSync(join(root, "gh.log"), "utf8").trim().split("\n") };
	}

	test("two stacked PRs (one by base branch only, past the 30th open PR) and one independent: the chain, the report, one list and one view per PR", () => {
		const filler = Array.from({ length: 35 }, (_, i) => head(300 + i, `plumb/f${i}`));
		const views = [
			{ ...pr(106, { base: "wl/wl-api" }), headRefName: "wl/wl-ui" },
			{ ...pr(139), headRefName: "plumb/docs" },
			{ ...pr(101, { body: "Depends-on: #99" }), headRefName: "wl/wl-api" },
			{ ...pr(99, { state: "MERGED" }), headRefName: "wl/wl-old" },
		];
		const w = world(views, [...filler, head(139, "plumb/docs"), head(106, "wl/wl-ui"), head(101, "wl/wl-api")]);
		const r = w.run("order", "--repo", REPO, "--prs", "106,#139, 101");
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		const [chain, json, ...rest] = r.out.trim().split("\n");
		expect(rest).toEqual([]);
		expect(chain).toBe("#99 ✓ → #101 → #106 · #139");
		expect(JSON.parse(json!)).toEqual({ order: [101, 106, 139], waiting: {}, cycles: [], chain, unrecorded: [{ pr: 106, dependsOn: 101 }] });
		const view = (n: number) => `pr view ${n} -R ${REPO} --json number,state,body,baseRefName,headRefName`;
		expect(w.calls()).toEqual([`pr list -R ${REPO} --state open --limit 1000 --json number,headRefName,isCrossRepository`, view(106), view(139), view(101), view(99)]);
	});

	test("a fork PR heading a train PR's base branch: no edge, nothing unrecorded, no view of the fork", () => {
		const views = [
			{ ...pr(111, { base: "feature/x" }), headRefName: "feature/z" },
			{ ...pr(110), headRefName: "feature/y" },
		];
		const w = world(views, [head(110, "feature/y"), head(150, "feature/x", true), head(111, "feature/z")]);
		const r = w.run("order", "--repo", REPO, "--prs", "111,110");
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		const [chain, json, ...rest] = r.out.trim().split("\n");
		expect(rest).toEqual([]);
		expect(chain).toBe("#111 · #110");
		expect(JSON.parse(json!)).toEqual({ order: [111, 110], waiting: {}, cycles: [], chain, unrecorded: [] });
		const view = (n: number) => `pr view ${n} -R ${REPO} --json number,state,body,baseRefName,headRefName`;
		expect(w.calls()).toEqual([`pr list -R ${REPO} --state open --limit 1000 --json number,headRefName,isCrossRepository`, view(111), view(110)]);
	});

	test("an open-PR list without isCrossRepository is an unexpected shape: exit 2", () => {
		const w = world([{ ...pr(111), headRefName: "feature/z" }], [{ number: 111, headRefName: "feature/z" } as OpenHead]);
		const r = w.run("order", "--repo", REPO, "--prs", "111");
		expect(r.code).toBe(2);
		expect(r.err).toContain("returned an unexpected shape");
	});

	test("a usage error or a failing gh exits 2", () => {
		const w = world([], []);
		for (const args of [["order", "--repo", REPO], ["order", "--repo", "nope", "--prs", "1"], ["order", "--repo", REPO, "--prs", "x"]]) {
			expect({ args, code: w.run(...args).code }).toEqual({ args, code: 2 });
		}
		const missing = w.run("order", "--repo", REPO, "--prs", "5");
		expect(missing.code).toBe(2);
		expect(missing.err).toContain(`gh pr view 5 -R ${REPO} --json number,state,body,baseRefName,headRefName failed: no pull requests found`);
	});
});
