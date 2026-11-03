// Main state, attempts, the merge gate and attribution (PLAN wl-mvq4edbaf13vnk § 2 "Main state", "Attempts", "The merge
// gate"; D2; R3 to R6), over fixture rows shaped as the runner writes them.
import { describe, expect, test } from "bun:test";
import { type EntryRow, TEST_RUNNER_BY } from "../../ledger/src/index";
import {
	attemptBlock, attribute, believable, CHAIN_MAX, type ChainCommit, type GateFacts, ghMainChain, mainResults, mainState, mainVerdicts, mergeGate, parseRunnerPreflight,
	runnerPreflightBody,
} from "../src/main-state";
import { type ExecCounts, type ResultRecord, testRunBody, type TestVerdict } from "../src/test-run";

const sha = (c: string) => c.repeat(40);
const [S1, S2, S3, S4, S5] = ["1", "2", "3", "4", "5"].map(sha) as [string, string, string, string, string];
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const EXEC: ExecCounts = { files: 100, tests: 1000, treeFiles: 100 };

let seq = 0;
/** A main run's settled result as `mainResults` reads it; `at` is minutes before NOW (ledger order is the array order). */
function result(commit: string, verdict: TestVerdict, over: { exec?: ExecCounts | null; at?: number; main?: boolean; reason?: string } = {}): ResultRecord {
	const n = ++seq;
	return {
		runId: `tr-0main${n}`, verdict, sha: commit, pr: over.main === false ? 17 : 0, reason: over.reason ?? null, headAtEnd: commit, base: null, mergeBase: null,
		full: null, solo: [], failures: [], runDir: null, preflight: "ok", scope: "full", main: over.main ?? true, host: "mac",
		exec: over.exec === undefined ? EXEC : over.exec, entryId: `en-${n}`, createdAt: minAgo(over.at ?? 0),
	};
}
/** First-parent commits, newest first: each landed `m` minutes before NOW. */
const chain = (...c: [string, number][]): ChainCommit[] => c.map(([s, m]) => ({ sha: s, tree: s.replace(/./g, "f"), date: minAgo(m), prs: [] }));

describe("believability and verdicts (R3)", () => {
	test("believable at 95 % of the tree's test files and 80 % of the last green's tests, not a hair under; no counts never", () => {
		expect(believable({ files: 95, tests: 800, treeFiles: 100 }, 1000)).toBe(true);
		expect(believable({ files: 94, tests: 1000, treeFiles: 100 }, 1000)).toBe(false);
		expect(believable({ files: 100, tests: 799, treeFiles: 100 }, 1000)).toBe(false);
		// no green yet: no test-count baseline
		expect(believable({ files: 100, tests: 1, treeFiles: 100 }, null)).toBe(true);
		expect(believable(null, null)).toBe(false);
		expect(believable({ files: 0, tests: 0, treeFiles: 0 }, null)).toBe(false);
	});

	test("a commit's verdict is its first conclusive main run and never changes; implausible counts as its own verdict", () => {
		const v = mainVerdicts([
			result(S1, "error"), result(S1, "green"), result(S1, "red"),
			result(S2, "red"), result(S2, "green"),
			result(S3, "green", { exec: { files: 90, tests: 1000, treeFiles: 100 } }), result(S3, "green"),
			result(S4, "stale"), result(S4, "superseded"),
			result(S5, "green", { main: false }),
		]);
		expect(v.get(S1)?.verdict).toBe("green");
		expect(v.get(S2)?.verdict).toBe("red");
		expect(v.get(S3)?.verdict).toBe("implausible");
		// inconclusive runs make no verdict; a PR run is no main run
		expect(v.has(S4)).toBe(false);
		expect(v.has(S5)).toBe(false);
		// red-main of a main run is red; a green without exec counts is implausible
		const w = mainVerdicts([result(S1, "red-main"), result(S2, "green", { exec: null })]);
		expect([w.get(S1)?.verdict, w.get(S2)?.verdict]).toEqual(["red", "implausible"]);
	});

	test("the 80 % baseline is the newest green verdict before the run; an implausible run never lowers it", () => {
		const v = mainVerdicts([
			result(S1, "green", { exec: { files: 100, tests: 1000, treeFiles: 100 } }),
			// a collapse to 500 tests is implausible, and stays out of the baseline
			result(S2, "green", { exec: { files: 100, tests: 500, treeFiles: 100 } }),
			result(S3, "green", { exec: { files: 100, tests: 600, treeFiles: 100 } }),
			result(S4, "green", { exec: { files: 100, tests: 800, treeFiles: 100 } }),
			result(S5, "green", { exec: { files: 100, tests: 650, treeFiles: 100 } }),
		]);
		expect([S1, S2, S3, S4, S5].map((s) => v.get(s)?.verdict)).toEqual(["green", "implausible", "implausible", "green", "green"]);
	});
});

describe("main state: red, unknown, open (R4)", () => {
	test("open with k ≤ 2 recent suspects and nothing red or inconclusive; the third suspect stops landing", () => {
		const runs = [result(S1, "green")];
		const two = mainState(chain([S3, 5], [S2, 10], [S1, 60]), runs, NOW);
		expect(two).toMatchObject({ tip: S3, g: S1, k: 2, red: false, unknown: false, open: true, stop: null, reasons: [] });
		expect(two.suspects.map((s) => s.sha)).toEqual([S2, S3]);
		const three = mainState(chain([S4, 2], [S3, 5], [S2, 10], [S1, 60]), runs, NOW);
		expect(three).toMatchObject({ k: 3, open: false, stop: "depth", reasons: ["3 suspects, over 2"] });
		// the tip itself verified: no suspects
		expect(mainState(chain([S1, 60]), runs, NOW)).toMatchObject({ g: S1, k: 0, open: true, oldestMs: null });
	});

	test("a red or implausible suspect is a regression; every other reason is still named, red first", () => {
		const runs = [result(S1, "green"), result(S2, "red"), result(S3, "green", { exec: { files: 10, tests: 1000, treeFiles: 100 } }), result(S4, "error", { reason: "timeout" })];
		const s = mainState(chain([S4, 50], [S3, 55], [S2, 58], [S1, 120]), runs, NOW);
		expect(s.red).toBe(true);
		expect(s.unknown).toBe(false);
		expect(s.stop).toBe("regression");
		expect(s.reasons).toEqual([
			`${S2.slice(0, 7)} is red (run ${runs[1]!.runId})`,
			`${S3.slice(0, 7)} is implausible (run ${runs[2]!.runId})`,
			`${S4.slice(0, 7)} has an inconclusive main run ${runs[3]!.runId} (error: timeout) and no verdict`,
			`oldest suspect ${S2.slice(0, 7)} landed 58 minutes ago, over 40`,
			"3 suspects, over 2",
		]);
	});

	test("unknown: an inconclusive suspect run with no verdict, a suspect older than 40 minutes (not at 40), or no G in the chain", () => {
		const g = result(S1, "green");
		const inconclusive = mainState(chain([S2, 5], [S1, 60]), [g, result(S2, "stale")], NOW);
		expect(inconclusive).toMatchObject({ red: false, unknown: true, open: false, stop: "infrastructure" });
		// a suspect with no run yet is not inconclusive
		expect(mainState(chain([S2, 5], [S1, 60]), [g], NOW).open).toBe(true);
		expect(mainState(chain([S2, 40], [S1, 60]), [g], NOW).open).toBe(true);
		const old = mainState(chain([S2, 40], [S1, 60]), [g], NOW + 1);
		expect(old).toMatchObject({ unknown: true, stop: "infrastructure", reasons: [`oldest suspect ${S2.slice(0, 7)} landed 40 minutes ago, over 40`] });
		const none = mainState(chain([S2, 5], [S1, 10]), [], NOW);
		expect(none).toMatchObject({ g: null, k: 2, unknown: true, open: false, reasons: ["no verified commit in the 2 newest first-parent commits"] });
		// an inconclusive run after which the commit earned a verdict is no longer inconclusive
		expect(mainState(chain([S2, 5], [S1, 60]), [g, result(S2, "error"), result(S2, "green")], NOW)).toMatchObject({ g: S2, open: true });
	});

	test("only a newer green, believable verdict reopens: a later green run of the red commit changes nothing", () => {
		const runs = [result(S1, "green"), result(S2, "red"), result(S2, "green")];
		expect(mainState(chain([S2, 5], [S1, 60]), runs, NOW)).toMatchObject({ red: true, open: false });
		// the revert S3 lands and verifies: G moves past the red commit
		expect(mainState(chain([S3, 1], [S2, 50], [S1, 60]), [...runs, result(S3, "green")], NOW)).toMatchObject({ g: S3, k: 0, red: false, open: true });
		// an implausible green on the revert does not
		const implausible = mainState(chain([S3, 1], [S2, 50], [S1, 60]), [...runs, result(S3, "green", { exec: { files: 50, tests: 1000, treeFiles: 100 } })], NOW);
		expect(implausible).toMatchObject({ g: S1, red: true, open: false });
	});

	test("an empty chain or an unreadable date is an error, never a state", () => {
		expect(() => mainState([], [], NOW)).toThrow("chain of main commits is empty");
		expect(() => mainState([{ sha: S2, tree: S2, date: "yesterday", prs: [] }, ...chain([S1, 60])], [result(S1, "green")], NOW)).toThrow("no readable date");
	});
});

describe("attempt blocks (§ 2 Attempts)", () => {
	test("3 inconclusive attempts exhaust a block; only a main-retry strictly newer than its last attempt opens the next", () => {
		const runs = [result(S2, "error", { at: 30 }), result(S2, "stale", { at: 20 }), result(S1, "error", { at: 15 }), result(S2, "error", { at: 10 }), result(S2, "error", { at: 9, main: false })];
		expect(attemptBlock(S2, runs.slice(0, 2), [])).toEqual({ block: 1, attempts: 2, exhausted: false });
		expect(attemptBlock(S2, runs, [])).toEqual({ block: 1, attempts: 3, exhausted: true });
		// a retry before the block was exhausted opens nothing; one at the last attempt's time is not newer
		expect(attemptBlock(S2, runs, [minAgo(25)])).toEqual({ block: 1, attempts: 3, exhausted: true });
		expect(attemptBlock(S2, runs, [minAgo(10)])).toEqual({ block: 1, attempts: 3, exhausted: true });
		expect(attemptBlock(S2, runs, [minAgo(5)])).toEqual({ block: 2, attempts: 0, exhausted: false });
		// the next block's attempts count again, and exhaust again
		const more = [...runs, result(S2, "error", { at: 4 }), result(S2, "error", { at: 3 }), result(S2, "error", { at: 2 })];
		expect(attemptBlock(S2, more, [minAgo(5)])).toEqual({ block: 2, attempts: 3, exhausted: true });
		expect(attemptBlock(S2, more, [minAgo(5), minAgo(1)])).toEqual({ block: 3, attempts: 0, exhausted: false });
		// conclusive runs are no attempts
		expect(attemptBlock(S1, [result(S1, "green"), result(S1, "red")], [])).toEqual({ block: 1, attempts: 0, exhausted: false });
	});
});

describe("the merge gate (R5)", () => {
	const G = S1;
	const open = mainState(chain([S2, 5], [G, 60]), [result(G, "green")], NOW);
	const red = mainState(chain([S2, 5], [G, 60]), [result(G, "green"), result(S2, "red")], NOW);
	const X = sha("9");
	const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
		head: X, containsTip: true, state: open, need: "fast", result: { verdict: "green", sha: X, scope: "fast", host: "linux" }, repair: null, treeEqualsG: false, ...over,
	});

	test("landing open: success for a passing check at a head containing the tip; a full green passes a fast need", () => {
		expect(mergeGate(facts())).toEqual({ state: "success", description: "fast check green" });
		expect(mergeGate(facts({ result: { verdict: "green", sha: X, scope: "full", host: "mac" } }))).toEqual({ state: "success", description: "full suite green" });
		expect(mergeGate(facts({ need: "full", result: { verdict: "green", sha: X, scope: "full", host: "mac" } }))).toEqual({ state: "success", description: "full suite green" });
	});

	test("landing open: failure naming every reason; red-main fails; a full need takes only a full Mac green", () => {
		expect(mergeGate(facts({ need: "full" }))).toEqual({ state: "failure", reasons: ["9999999 needs the full suite on the Mac before merge; its green is fast on linux"] });
		expect(mergeGate(facts({ need: "full", result: { verdict: "green", sha: X, scope: "full", host: "linux" } })).state).toBe("failure");
		expect(mergeGate(facts({ result: { verdict: "red-main", sha: X, scope: "full", host: "mac" } }))).toEqual({ state: "failure", reasons: ["9999999 is red-main: its failures also fail on main"] });
		expect(mergeGate(facts({ result: { verdict: "red", sha: X, scope: "fast", host: "linux" } }))).toEqual({ state: "failure", reasons: ["9999999's fast check is red"] });
		// a result at another head is no result at this one; both reasons are named
		expect(mergeGate(facts({ containsTip: false, result: { verdict: "green", sha: S3, scope: "fast", host: "linux" } }))).toEqual({
			state: "failure", reasons: [`head 9999999 does not contain main's tip ${S2.slice(0, 7)}; merge main in`, "no fast check result at 9999999"],
		});
		expect(mergeGate(facts({ containsTip: false })).state).toBe("failure");
	});

	test("landing stopped: only the incident's one repair passes; anything else fails naming the stop", () => {
		expect(mergeGate(facts({ state: red, repair: "revert", treeEqualsG: true, result: null }))).toEqual({ state: "success", description: "repair: revert to G's tree" });
		expect(mergeGate(facts({ state: red, repair: "fix", result: { verdict: "green", sha: X, scope: "full", host: "mac" } }))).toEqual({ state: "success", description: "repair: fix, full suite green" });
		expect(mergeGate(facts({ state: red, repair: "revert", treeEqualsG: false, result: { verdict: "green", sha: X, scope: "full", host: "mac" } }))).toEqual({ state: "success", description: "repair: partial revert, full suite green" });
		const stop = `landing stopped (regression): ${red.reasons.join("; ")}`;
		expect(mergeGate(facts({ state: red }))).toEqual({ state: "failure", reasons: [stop, "9999999 is not the incident's repair"] });
		expect(mergeGate(facts({ state: red, repair: "revert", treeEqualsG: false }))).toEqual({ state: "failure", reasons: [stop, "the partial revert 9999999 has no full-suite green on the Mac at its head"] });
		expect(mergeGate(facts({ state: red, repair: "revert", result: { verdict: "green", sha: X, scope: "full", host: "linux" } })).state).toBe("failure");
		expect(mergeGate(facts({ state: red, repair: "revert", result: { verdict: "green", sha: S3, scope: "full", host: "mac" } })).state).toBe("failure");
		expect(mergeGate(facts({ state: red, repair: "fix" }))).toEqual({ state: "failure", reasons: [stop, "the fix 9999999 has no full-suite green on the Mac at its head"] });
		expect(mergeGate(facts({ state: red, repair: "revert", treeEqualsG: true, containsTip: false })).state).toBe("failure");
		// a full green is no pass while stopped unless the head is the repair
		expect(mergeGate(facts({ state: red, result: { verdict: "green", sha: X, scope: "full", host: "mac" } })).state).toBe("failure");
	});
});

describe("attribution (R6)", () => {
	test("names each suspect whose change reaches a failing test file, with the files; one reaching none is left out", () => {
		const files: Record<string, string> = {
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
			"src/b.test.ts": 'import { b } from "./b";\n',
			"other/o.ts": "export const o = 1;\n",
			"other/o.test.ts": 'import { o } from "./o";\n',
			"test/spawn.test.ts": 'Bun.spawnSync(["bun", "scripts/run.ts"]);\n',
			"scripts/run.ts": "",
		};
		const tree = { files: Object.keys(files), read: (p: string) => files[p] ?? null };
		const diffs = new Map<string, string[]>([[S2, ["src/a.ts"]], [S3, ["README.md"]], [S4, ["scripts/run.ts", "other/o.ts"]]]);
		expect(attribute([S2, S3, S4], ["./src/b.test.ts", "test/spawn.test.ts"], diffs, tree)).toEqual([
			{ sha: S2, files: ["src/b.test.ts"] },
			{ sha: S4, files: ["test/spawn.test.ts"] },
		]);
		expect(attribute([S2, S3, S4], ["other/x.test.ts"], diffs, tree)).toEqual([]);
		expect(() => attribute([S5], ["src/b.test.ts"], diffs, tree)).toThrow(`no diff for suspect ${S5}`);
	});
});

describe("ghMainChain", () => {
	/** A fake GitHub: first-parent history S5 → S4 → … → S1 (root), each with its pulls. */
	const fake = (over: Record<string, unknown> = {}) => {
		const calls: string[] = [];
		const order = [S5, S4, S3, S2, S1];
		const gh = (args: string[]): unknown => {
			const path = args[1]!;
			calls.push(path);
			if (Object.hasOwn(over, path)) return over[path];
			const pulls = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(path);
			if (pulls) return [{ number: 30 + order.indexOf(pulls[1]!) }, { number: 2 }];
			const c = /\/git\/commits\/([0-9a-f]{40})$/.exec(path)![1]!;
			const i = order.indexOf(c);
			return { sha: c, tree: { sha: sha("e") }, committer: { date: minAgo(i * 10) }, parents: i + 1 < order.length ? [{ sha: order[i + 1] }, { sha: sha("d") }] : [] };
		};
		return { gh, calls };
	};

	test("the first-parent chain, newest first, with tree, date and PRs, ending at the first stop sha inclusive or the root", () => {
		const { gh, calls } = fake();
		const c = ghMainChain("o/r", S5, gh, new Set([S3, S1]));
		expect(c.map((x) => x.sha)).toEqual([S5, S4, S3]);
		expect(c[0]).toEqual({ sha: S5, tree: sha("e"), date: minAgo(0), prs: [2, 30] });
		expect(calls).toEqual([`repos/o/r/git/commits/${S5}`, `repos/o/r/commits/${S5}/pulls`, `repos/o/r/git/commits/${S4}`, `repos/o/r/commits/${S4}/pulls`, `repos/o/r/git/commits/${S3}`, `repos/o/r/commits/${S3}/pulls`]);
		expect(ghMainChain("o/r", S5, fake().gh, new Set()).map((x) => x.sha)).toEqual([S5, S4, S3, S2, S1]);
	});

	test("at most CHAIN_MAX commits", () => {
		const shas = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(40, "a"));
		const gh = (args: string[]): unknown => {
			const path = args[1]!;
			if (path.endsWith("/pulls")) return [];
			const s = path.slice(path.lastIndexOf("/") + 1);
			const i = shas.indexOf(s);
			return { sha: s, tree: { sha: sha("e") }, committer: { date: minAgo(i) }, parents: [{ sha: shas[i + 1] ?? sha("0") }] };
		};
		expect(ghMainChain("o/r", shas[0]!, gh, new Set())).toHaveLength(CHAIN_MAX);
	});

	test("a misshapen answer or a failed call throws naming the call", () => {
		expect(() => ghMainChain("o/r", S5, fake({ [`repos/o/r/git/commits/${S5}`]: { sha: S5 } }).gh, new Set())).toThrow(`gh api repos/o/r/git/commits/${S5} returned an unexpected shape`);
		expect(() => ghMainChain("o/r", S5, fake({ [`repos/o/r/commits/${S5}/pulls`]: { message: "Not Found" } }).gh, new Set())).toThrow(`gh api repos/o/r/commits/${S5}/pulls returned an unexpected shape`);
		expect(() => ghMainChain("o/r", S5, fake({ [`repos/o/r/commits/${S5}/pulls`]: [{ title: "x" }] }).gh, new Set())).toThrow("a pull with no number");
		const failing = () => {
			throw new Error("gh api exited 1: HTTP 502");
		};
		expect(() => ghMainChain("o/r", S5, failing, new Set())).toThrow("HTTP 502");
	});
});

describe("the runner's ledger rows", () => {
	test("runner-preflight bodies round-trip; a refused one names its reason; malformed input throws", () => {
		const ok = { ok: true, reason: null, source: S1, root: "/Users/jo/.agent-system-2/verified/current" };
		expect(runnerPreflightBody(ok)).toBe(`runner-preflight: ok source ${S1} root /Users/jo/.agent-system-2/verified/current`);
		expect(parseRunnerPreflight(runnerPreflightBody(ok))).toEqual(ok);
		const refused = { ok: false, reason: "root has modified files: surface/src/x.ts", source: S1, root: "/r" };
		expect(parseRunnerPreflight(runnerPreflightBody(refused))).toEqual(refused);
		expect(() => runnerPreflightBody({ ...refused, reason: " " })).toThrow("names its reason");
		expect(() => runnerPreflightBody({ ...ok, source: "HEAD" })).toThrow("not a full sha");
		expect(() => runnerPreflightBody({ ...ok, root: "relative" })).toThrow("not an absolute path");
		expect(parseRunnerPreflight(`runner-preflight: maybe source ${S1} root /r`)).toBeNull();
	});

	test("mainResults reads only the runner's main runs, in ledger order", () => {
		const row = (id: string, by: string, r: ResultRecord): EntryRow => ({
			id, workload_id: "wl-standing", slice_id: null, kind: "assumption", body: testRunBody(r), created_by: by, created_at: r.createdAt,
		} as EntryRow);
		const main = result(S1, "green", { at: 5 });
		const pr = result(S2, "green", { at: 4, main: false });
		const forged = result(S3, "green", { at: 3 });
		const got = mainResults([row("en-a", TEST_RUNNER_BY, main), row("en-b", TEST_RUNNER_BY, pr), row("en-c", "lane-a", forged)]);
		expect(got.map((r) => [r.entryId, r.sha])).toEqual([["en-a", S1]]);
	});
});
