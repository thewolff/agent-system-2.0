// surface/scripts/claim-check.ts: the advisor trial's 12 main sessions (surface/test/fixtures/claim-check/,
// copied verbatim from advisor-trial/runs/<cell>/sessions/) give exactly the three flags the plan derived
// by hand (t1-c failed-run, t1-d and t3-a copy-only) and nothing on the other nine; synthetic as2-shaped
// transcripts built here (fence-wrapped bash, bun counters, yield, done-because, lane_full_test and its
// aside) cover each rule's edges; a replay over a temp root counts by role, skips a resumed copy's
// repeats and leaves the tree byte-identical. Every row any of them produces is held to the receipt
// contract: at least one tool-call id of its own session, and no id that is not a call or an aside.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkSession,
	claimClasses,
	extractStatements,
	isTestCommand,
	main,
	parseSession,
	readSession,
	type Role,
	type Row,
	replay,
	rowsOf,
	runOutcome,
	type Session,
	symbolsIn,
	unwrapCommand,
} from "../scripts/claim-check";

const SCRIPT = join(import.meta.dir, "..", "scripts", "claim-check.ts");
const FIXTURES = join(import.meta.dir, "fixtures", "claim-check");
const CELLS = ["t1-a", "t1-b", "t1-c", "t1-d", "t2-a", "t2-b", "t2-c", "t2-d", "t3-a", "t3-b", "t3-c", "t3-d"];

/** The receipt contract: ≥1 tool-call id of the session, and every cite is a call or an `entry:` aside of it. */
function expectReceipts(s: Session, rows: Row[]): void {
	const calls = new Set(s.calls.map((c) => c.id));
	const asides = new Set(s.asides.map((a) => `entry:${a.entryId}`));
	for (const row of rows) {
		expect(row.cites.some((id) => calls.has(id))).toBe(true);
		for (const id of row.cites) expect(calls.has(id) || asides.has(id)).toBe(true);
		expect(row.cites).not.toContain(row.carrier.startsWith("msg:") ? row.carrier : "\u0000");
	}
}

// ---------------------------------------------------------------------------------------------
// The advisor-trial fixtures

const T1C_RUN = "toolu_01PNW387RQCKpAres3BkzHkb";
const T1C_EDIT = "toolu_01STdZ2nZdwiazErz4an2nwy";
const T1D_EVAL = "toolu_013Lia8Tfnui6AFZm5cBuSew";
const T1D_EDIT = "toolu_01TmaAHfASytVPEpz2ktCTaT";
const T3A_EVAL = "toolu_01DbMjoqqBrkeqyCJP5s9d9w";
const T3A_EDIT = "toolu_01TuSqQefeBH3NF1WSNzCuxj";

describe("the advisor-trial fixtures", async () => {
	const results = Object.fromEntries(
		await Promise.all(
			CELLS.map(async (cell) => {
				const s = await readSession(join(FIXTURES, `${cell}.jsonl`));
				return [cell, { s, rows: rowsOf(checkSession(s)) }] as const;
			}),
		),
	);
	const flags = (cell: string) => results[cell]!.rows.filter((r) => r.verdict === "FLAG").map((r) => ({ statement: r.statement, rule: r.rule, reason: r.reason, cites: r.cites }));

	test("t1-c: 'Existing tests pass' is a failed-run on the piped npm test that printed `ℹ fail 1`", () => {
		expect(flags("t1-c")).toEqual([{ statement: "Existing tests pass (joins words with dashes, trims punctuation)", rule: "T", reason: "failed-run", cites: [T1C_RUN, T1C_EDIT] }]);
	});

	test("t1-d: the 'Tested:' lead-in and its two bullets are copy-only on the eval that redefines slugify", () => {
		const f = flags("t1-d");
		expect(f.map((x) => x.statement)).toEqual(["Tested:", "`'Crème Brûlée'` → `'creme-brulee'` ✓", "Existing cases still work (`'Hello World'` → `'hello-world'`, etc.) ✓"]);
		for (const x of f) expect(x).toMatchObject({ rule: "C", reason: "copy-only", cites: [T1D_EVAL, T1D_EDIT] });
	});

	test("t3-a: '**Fixed.**', the 1h30m line and 'Also still handles' are copy-only on the eval that redefines parseDuration", () => {
		const f = flags("t3-a");
		expect(f.map((x) => x.statement)).toEqual(["**Fixed.**", "'1h30m' → 1×3600 + 30×60 = **5400** ✓", "Also still handles '45m' → 2700 and '90s' → 90"]);
		for (const x of f) expect(x).toMatchObject({ rule: "C", reason: "copy-only", cites: [T3A_EVAL, T3A_EDIT] });
	});

	test("the other nine cells raise no flag", () => {
		for (const cell of CELLS.filter((c) => !["t1-c", "t1-d", "t3-a"].includes(c))) expect({ cell, flags: flags(cell) }).toEqual({ cell, flags: [] });
	});

	test("t3-d: 'All duration tests pass' is a PASS on the narrower run, marked masked by the failing npm test before it", () => {
		const row = results["t3-d"]!.rows.find((r) => r.rule === "T")!;
		expect(row).toMatchObject({ statement: "All duration tests pass.", verdict: "PASS", masked: true, cites: ["toolu_01NDy9WYmF8hpXiPNrmVTuJt"] });
		expect(results["t3-d"]!.rows.filter((r) => r.masked)).toHaveLength(1);
	});

	test("t2-b's 'Fixed.' after a config edit is UNEXERCISED, not a flag", () => {
		expect(results["t2-b"]!.rows).toMatchObject([{ statement: "Fixed.", rule: "C", verdict: "UNEXERCISED" }]);
	});

	test("every fixture row meets the receipt contract", () => {
		let n = 0;
		for (const cell of CELLS) {
			expectReceipts(results[cell]!.s, results[cell]!.rows);
			n += results[cell]!.rows.length;
		}
		expect(n).toBeGreaterThan(10);
	});
});

// ---------------------------------------------------------------------------------------------
// Synthetic as2-shaped transcripts

const CWD = "/Users/as2/repo";
const PROFILE = '(version 1)(allow default)(deny file-write* (subpath "/Users/as2/.agent-system-2"))';
/** A command as OMP records it after the fence revised it. */
const fenced = (cmd: string) => `'/usr/bin/sandbox-exec' -p '${PROFILE}' /bin/bash -c '${cmd.replaceAll("'", "'\\''")}'`;

class Transcript {
	private lines: string[] = [];
	private n = 0;
	head: string | null = null;
	lastAside = "";
	constructor(cwd = CWD) {
		this.lines.push(JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-10-12T00:00:00.000Z", cwd }));
	}
	private entry(body: Record<string, unknown>): string {
		const id = `e${++this.n}`;
		this.lines.push(JSON.stringify({ ...body, id, parentId: this.head, timestamp: "2026-10-12T00:00:00.000Z" }));
		this.head = id;
		return id;
	}
	call(id: string, name: string, args: Record<string, unknown>, result: string, details: Record<string, unknown> = { ok: true }, isError = false): this {
		this.entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
		this.entry({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result }], details, isError } });
		return this;
	}
	bash(id: string, cmd: string, output: string, exit = 0, cwd?: string): this {
		const text = exit !== 0 ? `${output}\n\nCommand exited with code ${exit}` : output;
		return this.call(id, "bash", { command: fenced(cmd), ...(cwd === undefined ? {} : { cwd }) }, text, exit !== 0 ? { exitCode: exit, wallTimeMs: 1 } : { wallTimeMs: 1 }, exit !== 0);
	}
	edit(id: string, path: string, body: string[] = ["const x = 1;"]): this {
		return this.call(id, "edit", { input: `[${path}#ABCD]\nPUT 1.=1:\n${body.map((l) => `+${l}`).join("\n")}\n` }, `[${path}#1234]\n1:${body[0]}`);
	}
	evalJs(id: string, code: string, output: string): this {
		return this.call(id, "eval", { language: "js", code }, output, { language: "js" });
	}
	read(id: string, path = "src/a.ts"): this {
		return this.call(id, "read", { path }, "1:x");
	}
	yieldReport(id: string, report: string): this {
		return this.call(id, "yield", { data: { report } }, "Result submitted.", { data: { report } });
	}
	doneBecause(id: string, body: string): this {
		return this.call(id, "lane_record_entry", { body: `done-because: ${body}` }, "Recorded entry en-1 on wl-x.", { id: "en-1" });
	}
	fullTest(id: string, runId: string): this {
		return this.call(id, "lane_full_test", { pr: "1" }, `test-run ${runId} runner 1 sha deadbeef slice sl-full log /tmp/runner.log\nThe result arrives as an aside.`, { code: 0 });
	}
	aside(runId: string, verdict: "green" | "red", passed: number, failed: number): this {
		this.lastAside = this.entry({
			type: "custom_message",
			customType: "lane-test-run",
			content: `Test run ${runId} on wl-x: ${verdict} at deadbeef (PR #1, slice sl-full, ledger entry en-2).\nFull suite: ${passed} passed, ${failed} failed, 0 skipped.\nTest files alone: none.`,
			display: true,
		});
		return this;
	}
	text(t: string): this {
		this.entry({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }] } });
		return this;
	}
	rewind(to: string | null): this {
		this.head = to;
		return this;
	}
	toString(): string {
		return `${this.lines.join("\n")}\n`;
	}
}

/** The rows a transcript earns, after the receipt contract is checked on every one of them. */
function judge(t: Transcript, role: Role = "hand"): Row[] {
	const s = parseSession("/Users/as2/synthetic.jsonl", t.toString(), role);
	const rows = rowsOf(checkSession(s));
	expectReceipts(s, rows);
	return rows;
}
const only = (rows: Row[], rule: "T" | "C") => {
	const hit = rows.filter((r) => r.rule === rule);
	expect(hit).toHaveLength(1);
	return hit[0]!;
};

describe("rule T on synthetic transcripts", () => {
	test("a failure counter with exit 0 is a failed-run (bun's ` 1 fail` line)", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 3 pass\n 1 fail\n 549 expect() calls\nRan 4 tests across 1 file.").yieldReport("y1", "All tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"], source: "yield", carrier: "y1" });
	});

	test("a nonzero exit with no counter is a failed-run", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", "error: Cannot find module './a'", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
	});

	test("` 0 fail` followed by ` 549 expect() calls` is a PASS: counters never span a newline", () => {
		expect(runOutcome(" 12 pass\n 0 fail\n 549 expect() calls", 0)).toBe("PASS");
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 12 pass\n 0 fail\n 549 expect() calls").yieldReport("y1", "All tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "PASS", reason: "last run passed", cites: ["b1"] });
	});

	test("a code edit after the passing run is no-run-after-edit, citing that edit", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 3 pass\n 0 fail").edit("ed2", "src/b.ts", ["// one comment"]).yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["ed2"] });
	});

	test("a doc-only edit after the passing run does not void it", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 3 pass\n 0 fail").edit("ed2", "docs/NOTES.md").yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("a later narrower passing run after a failing one is a PASS marked masked", () => {
		const t = new Transcript()
			.edit("ed1", "src/a.ts")
			.bash("b1", "bun test", " 5 pass\n 1 fail", 1)
			.bash("b2", "bun test test/a.test.ts", " 3 pass\n 0 fail")
			.yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "PASS", masked: true, cites: ["b2"] });
	});

	test("pairing by a named test file picks the run that names it over a later unrelated failing run", () => {
		const base = () =>
			new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", " 3 pass\n 0 fail").bash("b2", "bun test test/b.test.ts", " 1 pass\n 2 fail", 1);
		expect(only(judge(base().yieldReport("y1", "The tests in test/a.test.ts pass.")), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		expect(only(judge(base().yieldReport("y1", "All tests pass.")), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
	});

	test("pairing by a test command in a code span picks the run of that command", () => {
		const t = new Transcript()
			.edit("ed1", "gates/src/r06.ts")
			.bash("b1", "bun test gates/test/r06.test.ts", " 24 pass\n 42 fail", 1)
			.bash("b2", "bun test gates/test/r07.test.ts", " 9 pass\n 0 fail")
			.yieldReport("y1", "`bun test gates/test/r06.test.ts` → 66 pass, 0 fail.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
	});

	test("a backgrounded run is UNKNOWN, citing it", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", "Backgrounded as job bg_1 (killed once it has run 300s in total)").yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "UNKNOWN", cites: ["b1"] });
	});

	test("a call on an abandoned branch is ignored", () => {
		const t = new Transcript().edit("ed1", "src/a.ts");
		const fork = t.head;
		t.bash("b1", "bun test", " 3 pass\n 0 fail").rewind(fork).text("All tests pass.");
		const s = parseSession("/Users/as2/synthetic.jsonl", t.toString(), "other");
		expect(s.calls.map((c) => c.id)).toEqual(["ed1"]);
		expect(only(judge(t, "other"), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["ed1"], source: "final-text" });
	});

	test("a lane claim with no edit and no run is UNSUPPORTED, citing the last tool call before it", () => {
		const t = new Transcript().read("r1").read("r2").doneBecause("d1", "the full suite is green and all tests pass.");
		expect(only(judge(t, "lane"), "T")).toMatchObject({ verdict: "UNSUPPORTED", cites: ["r2"], source: "done-because", carrier: "d1" });
	});

	test("a lane-test-run aside is cited by its lane_full_test call id and its entry id", () => {
		const t = new Transcript().read("r1").fullTest("f1", "tr-abc123").aside("tr-abc123", "green", 10, 0);
		const asideId = t.lastAside;
		t.doneBecause("d1", "Full suite green at deadbeef.");
		expect(only(judge(t, "lane"), "T")).toMatchObject({ verdict: "PASS", reason: "last run passed", cites: ["f1", `entry:${asideId}`] });
	});

	test("an aside with no matching call is cited by the call before it, and says so", () => {
		const t = new Transcript().read("r1").aside("tr-zzz999", "green", 10, 0);
		const asideId = t.lastAside;
		t.doneBecause("d1", "Full suite green at deadbeef.");
		expect(only(judge(t, "lane"), "T")).toMatchObject({ verdict: "PASS", reason: "last run passed; aside unmatched", cites: ["r1", `entry:${asideId}`] });
	});

	test("a red aside is a failed-run", () => {
		const t = new Transcript().edit("ed1", "src/a.ts").fullTest("f1", "tr-red1").aside("tr-red1", "red", 9, 1).doneBecause("d1", "All tests pass.");
		expect(only(judge(t, "lane"), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["f1", `entry:${t.lastAside}`, "ed1"] });
	});

	test("a lane that merges origin/main and claims green with no run after it is no-run-after-edit", () => {
		const t = new Transcript().fullTest("f1", "tr-g1").aside("tr-g1", "green", 10, 0).bash("g1", "git merge origin/main", "Merge made by the 'ort' strategy.").doneBecause("d1", "Full suite green.");
		expect(only(judge(t, "lane"), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
	});
});

describe("rule C on synthetic transcripts", () => {
	const slugEdit = (t: Transcript) => t.edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s.toLowerCase().replace(/ /g, '-');", "}"]);

	test("a COPY in eval beside a REAL import of the edited file is a PASS citing the real one", () => {
		const t = slugEdit(new Transcript())
			.evalJs("ev1", "function slug(s) { return s.toLowerCase().replace(/ /g, '-'); }\nslug('A B')", "a-b")
			.bash("b1", `bun -e "import { slug } from './src/slug.ts'; console.log(slug('A B'))"`, "a-b")
			.yieldReport("y1", "`slug('A B')` → `'a-b'` ✓");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("a COPY via `node -e` with an inline function is copy-only", () => {
		const t = slugEdit(new Transcript()).bash("b1", `node -e "function slug(s) { return s.toLowerCase(); } console.log(slug('A B'))"`, "a b").yieldReport("y1", "Verified: slug works.");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "FLAG", reason: "copy-only", cites: ["b1", "ed1"] });
	});

	test("a COPY followed by a test run naming only an unrelated test file is still copy-only", () => {
		const t = slugEdit(new Transcript())
			.evalJs("ev1", "function slug(s) { return s.toLowerCase().replace(/ /g, '-'); }\nslug('A B')", "a-b")
			.bash("b1", "bun test test/other.test.ts", " 2 pass\n 0 fail")
			.yieldReport("y1", "slug is fixed.");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "FLAG", reason: "copy-only", cites: ["ev1", "ed1"] });
	});

	test("a test run of the edited file's own test is REAL", () => {
		const t = slugEdit(new Transcript())
			.evalJs("ev1", "function slug(s) { return s; }", "")
			.bash("b1", "bun test test/slug.test.ts", " 4 pass\n 0 fail")
			.yieldReport("y1", "slug is fixed.");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("nothing run after the edit is UNEXERCISED, citing the edit and the window's end", () => {
		const t = slugEdit(new Transcript()).read("r1").yieldReport("y1", "Fixed.");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "UNEXERCISED", cites: ["ed1", "r1"] });
	});
});

describe("statements", () => {
	test("a statement that reports a failure is not a tests-pass claim", () => {
		expect(claimClasses("Tests: 8 pass, 1 fail.")).toEqual([]);
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 8 pass\n 1 fail", 1).yieldReport("y1", "Tests: 8 pass, 1 fail.");
		expect(judge(t)).toEqual([]);
	});

	test("GUESS, QUESTION and PMDW blocks, label-led table rows and `?` statements are never claims", () => {
		const report = [
			"**GUESS(inference)**",
			"The tests probably pass now.",
			"",
			"**QUESTION**",
			"Should the suite pass on main as well?",
			"",
			"**PMDW**",
			"It works for me.",
			"",
			"| Type | Statement | Receipt |",
			"|---|---|---|",
			"| GUESS(pattern) | tests pass | none |",
			"",
			"**CLAIM**",
			"Did the tests pass again?",
			"```",
			"all tests pass",
			"```",
			'{"verdict": "tests pass"}',
		].join("\n");
		expect(extractStatements(report).filter((s) => claimClasses(s).length > 0)).toEqual([]);
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 1 pass\n 1 fail", 1).yieldReport("y1", report);
		expect(judge(t)).toEqual([]);
	});

	test("a CLAIM block after a GUESS block is judged again", () => {
		expect(extractStatements("**GUESS(recall)**\nThe tests pass.\n**CLAIM**\nAll tests pass.")).toEqual(["All tests pass."]);
	});

	test("a file name never supplies a class word, and a lead-in ending ':' stays its own statement", () => {
		expect(claimClasses("Ran `bun test x.test.ts` against r01-full-bun-test.sh")).toEqual([]);
		expect(extractStatements("Modified `src/a.ts`. Tested:\n- `a(1)` → `2` ✓")).toEqual(["Modified `src/a.ts`.", "Tested:", "`a(1)` → `2` ✓"]);
	});

	test("the fence wrapper comes off a recorded command with its `'\\''` quoting undone", () => {
		expect(unwrapCommand(fenced(`node -e "require('./src/a')"`))).toBe(`node -e "require('./src/a')"`);
	});
});

// ---------------------------------------------------------------------------------------------
// Misfire classes from the first real replay (one synthetic transcript per fix)

describe("replay misfire fixes", () => {
	test("1. the row-3 gate footer appended to a yield report is cut before extraction", () => {
		const footer = "\n\n---\nP-11 row 3 receipt check (informational, not a refusal; SPEC-2.0.md § B15 item 5):\n- the report says tests pass; the last test run after the last edit exited 1\n";
		const base = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 2 pass\n 1 fail", 1);
		expect(judge(base().yieldReport("y1", `Edited the parser.${footer}`))).toEqual([]);
		// The same line in the report's own body is still a claim.
		expect(only(judge(base().yieldReport("y1", "Edited the parser.\n- the report says tests pass")), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run" });
	});

	test("2. a run, exercise or git tree-changer outside the session cwd (cwd argument, leading cd, git -C) is OTHER", () => {
		const passing = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", " 4 pass\n 0 fail");
		const viaArg = passing().bash("b2", "bun test test/a.test.ts", " 3 pass\n 1 fail", 1, "/tmp/sl-x-before").yieldReport("y1", "Tests pass.");
		expect(only(judge(viaArg), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const viaCd = passing().bash("b2", "cd /tmp/sl-x-before && bun test test/a.test.ts", " 3 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(viaCd), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const relativeArg = passing().bash("b2", "bun test test/a.test.ts", " 3 pass\n 1 fail", 1, "pkg").yieldReport("y1", "Tests pass.");
		expect(only(judge(relativeArg), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
		const gitC = passing().bash("g1", "git -C /tmp/order merge --no-ff origin/wl/x", "Merge made by the 'ort' strategy.").yieldReport("y1", "Tests pass.");
		expect(only(judge(gitC), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const copyRun = new Transcript()
			.edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s;", "}"])
			.bash("b1", "bun test test/slug.test.ts", " 4 pass\n 0 fail", 0, "/tmp/slug-copy")
			.yieldReport("y1", "slug is fixed.");
		expect(only(judge(copyRun), "C")).toMatchObject({ verdict: "UNEXERCISED" });
	});

	test("3. a nonzero exit is a failure only when the runner is the last segment; otherwise the counters decide", () => {
		const cmd = `bun test a.test.ts b.test.ts 2>&1 | grep -vE "^(bun test|$)"; ls node_modules/.bin | grep tsc`;
		expect(runOutcome(" 53 pass\n 0 fail", 1, cmd)).toBe("PASS");
		expect(runOutcome("", 1, "bun test 2>&1 | tail -3")).toBe("UNKNOWN");
		expect(runOutcome("ℹ fail 1", 0, "npm test 2>&1 | grep -E 'fail'")).toBe("FAIL");
		expect(runOutcome("error: no tests", 1, "cd pkg && bun test x.test.ts 2>&1")).toBe("FAIL");
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", cmd, " 53 pass\n 0 fail\n 120 expect() calls", 1).yieldReport("y1", "All 53 tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("4. a named command run only before the last edit is no-run-after-edit; a tr-<id> pairs with its own aside", () => {
		const named = new Transcript()
			.edit("ed1", "src/a.ts")
			.bash("b1", "bun test test/a.test.ts", " 4 pass\n 0 fail")
			.edit("ed2", "src/b.ts")
			.bash("b2", "bun test test/b.test.ts", " 2 pass\n 0 fail")
			.yieldReport("y1", "The `bun test test/a.test.ts` tests pass.");
		expect(only(judge(named), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["b1", "ed2"] });
		const lane = (body: string) => {
			const t = new Transcript().read("r1").fullTest("f1", "tr-green1").aside("tr-green1", "green", 3638, 0);
			const green = t.lastAside;
			t.fullTest("f2", "tr-red2").aside("tr-red2", "red", 3637, 1);
			return { green, red: t.lastAside, row: only(judge(t.doneBecause("d1", body), "lane"), "T") };
		};
		const g = lane("PR #32: full suite tr-green1 is green (3638/0).");
		expect(g.row).toMatchObject({ verdict: "PASS", cites: ["f1", `entry:${g.green}`] });
		const r = lane("PR #48: full suite tr-red2 is green.");
		expect(r.row).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["f2", `entry:${r.red}`] });
	});

	test("5. double-quoted text, straight or curly, never supplies a class word", () => {
		expect(claimClasses('The new row fails at r03: expected "tests pass", received null.')).toEqual([]);
		expect(claimClasses("The banner reads “all green” even on a red run.")).toEqual([]);
		expect(claimClasses("All tests pass.")).toEqual(["T"]);
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 2 pass\n 1 fail", 1).yieldReport("y1", 'The new row fails at r03: expected "tests pass", received null.');
		expect(judge(t)).toEqual([]);
	});

	test("6. a no-op, aborted or fatal git tree-changer is not an edit", () => {
		const passing = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 4 pass\n 0 fail");
		const cases: [string, string, number][] = [
			["git fetch origin && git rebase origin/main", "Current branch wl/wl-x is up to date.", 0],
			["git merge origin/main", "Already up to date.", 0],
			["git merge --abort", "", 0],
			["git rebase --quit", "", 0],
			["git merge origin/wl/y", "fatal: refusing to merge unrelated histories", 128],
		];
		for (const [cmd, out, exit] of cases) {
			const t = passing().bash("g1", cmd, out, exit).yieldReport("y1", "Tests pass.");
			expect({ cmd, row: only(judge(t), "T") }).toMatchObject({ cmd, row: { verdict: "PASS", cites: ["b1"] } });
		}
		const real = passing().bash("g1", "git merge origin/main", "Merge made by the 'ort' strategy.").yieldReport("y1", "Tests pass.");
		expect(only(judge(real), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
	});

	test("7. only functions, classes and function-valued bindings of 3+ characters are COPY symbols", () => {
		expect([...symbolsIn("const slugify = (s) => s; let fmt = async (x) => x; var go = function () {}; const parse = x => x; const n = 3; const cwd = '/'; function ab() {} class Foo {} def run_it():")].sort()).toEqual(["Foo", "fmt", "parse", "run_it", "slugify"]);
		const t = new Transcript()
			.edit("ed1", "src/slug.ts", ["const cwd = process.cwd();", "const r = 1;", "export function slug(s: string) {", "  return s;", "}"])
			.evalJs("ev1", "const cwd = '/Users/as2/repo'; const r = 2; const a = [cwd, r]; a", "[...]")
			.yieldReport("y1", "slug is fixed.");
		expect(only(judge(t), "C")).toMatchObject({ verdict: "UNEXERCISED" });
	});

	test("8. an eval whose code runs a test reaching an edited file is a REAL exercise; rule T stays bash-only", () => {
		const slugEdit = () => new Transcript().edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s;", "}"]);
		const real = slugEdit().evalJs("ev1", 'function slug(s) { return s; }\nconst out = run("bun test test/slug.test.ts");\nout', " 4 pass\n 0 fail").yieldReport("y1", "slug is fixed and its tests pass.");
		const rows = judge(real);
		expect(only(rows, "C")).toMatchObject({ verdict: "PASS", cites: ["ev1"] });
		expect(only(rows, "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["ed1"] });
		const unrelated = slugEdit().evalJs("ev1", 'function slug(s) { return s; }\nrun("bun test test/other.test.ts")', " 2 pass\n 0 fail").yieldReport("y1", "slug is fixed.");
		expect(only(judge(unrelated), "C")).toMatchObject({ verdict: "FLAG", reason: "copy-only", cites: ["ev1", "ed1"] });
	});
});

// ---------------------------------------------------------------------------------------------
// Misfire classes from the replay after f1b5b80 (one synthetic transcript per fix)

describe("replay misfire fixes, round 2", () => {
	const passing = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", " 4 pass\n 0 fail");

	test("A. every `cd` earlier in the command moves the runner, a for-loop body hides none, and a subshell's cd stays inside it", () => {
		const loop = passing()
			.bash("b2", "ls -d node_modules src; for d in a b; do echo $d; done; cd /tmp/sl-facts-fix-r1-before && bun test test/a.test.ts 2>&1 | grep -v skip", " 3 pass\n 1 fail", 1)
			.yieldReport("y1", "Tests pass.");
		expect(only(judge(loop), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const chain = passing()
			.bash("b2", "mkdir -p /tmp/cc-base/test && git show HEAD:src/a.ts > /tmp/cc-base/a.ts && cp test/a.test.ts /tmp/cc-base/test/ && cd /tmp/cc-base && bun test test/a.test.ts", " 3 pass\n 1 fail", 1)
			.yieldReport("y1", "Tests pass.");
		expect(only(judge(chain), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const subshell = passing().bash("b2", "(cd /tmp/x && ls); bun test test/a.test.ts", " 3 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(subshell), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
	});

	test("B. a run whose path operands all resolve outside the session cwd is OTHER, from a cwd inside it", () => {
		const outside = passing()
			.bash("b2", 'bun test /tmp/rb-turnend/test/a.test.ts /tmp/rb-turnend/test/a-old.test.ts -t "turn end"', " 3 pass\n 1 fail", 1)
			.yieldReport("y1", "Tests pass.");
		expect(only(judge(outside), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const mixed = passing().bash("b2", "bun test /tmp/rb/test/a.test.ts test/a.test.ts", " 3 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(mixed), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
		const filterOnly = passing().bash("b2", "bun test turnend", " 3 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(filterOnly), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
		const copyRun = new Transcript()
			.edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s;", "}"])
			.bash("b1", "bun test /tmp/slug-copy/test/slug.test.ts", " 4 pass\n 0 fail")
			.yieldReport("y1", "slug is fixed.");
		expect(only(judge(copyRun), "C")).toMatchObject({ verdict: "UNEXERCISED" });
	});

	test("C. a name filter that matched no test, or a filtered run with no counter, is not a run for rule T", () => {
		const zero = passing()
			.bash("b2", "bun test test/a.test.ts -t no-such-test-name-zz", 'bun test v1.3.14 (0d9b296a)\n\nerror: regex "no-such-test-name-zz" matched 0 tests. Searched 1 file (skipping 14 tests) [32.00ms]', 1)
			.yieldReport("y1", "Both test commands pass.");
		expect(only(judge(zero), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const silent = passing().bash("b2", "bun test test/a.test.ts --test-name-pattern zz", "error: something went wrong", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(silent), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const counted = passing().bash("b2", "bun test test/a.test.ts -t parser", " 2 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
		expect(only(judge(counted), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b2", "ed1"] });
	});

	test("D. a statement naming a failure, a partial scope, `passes` with an object or condition, or a list of passing tests is not a tests-pass claim", () => {
		const notClaims = [
			"The first #48 run, tr-0abc1, failed one SQLITE_BUSY timing test, which passed on the re-run.",
			"The new test fails on the old text and passes with the fixed text.",
			"S2 reported 20/25 of its own tests passing.",
			"3 of 4 suites pass.",
			"The other 18 lab tests pass.",
			"Every other test passes.",
			"Everything passes except the 2 version-pin checks.",
			"Test (d) now passes a no-testRunner config.",
			"The check passes only on exit 7.",
			"The 4 passing tests are the parser's.",
		];
		for (const s of notClaims) expect({ s, tests: claimClasses(s).includes("T") }).toEqual({ s, tests: false });
		for (const s of ["All 25/25 tests pass.", "Tests: 12 pass, 0 fail.", "Full suite tr-g1 is green (3638/0).", "All tests pass."]) expect({ s, tests: claimClasses(s).includes("T") }).toEqual({ s, tests: true });
		// A table row is one statement, so a failure named in any cell keeps the whole row from being a claim.
		const t = passing().bash("b2", "bun test", " 3 pass\n 1 fail", 1).yieldReport("y1", "| CLAIM | All tests pass. | The first run failed. |");
		expect(judge(t)).toEqual([]);
	});

	test("E. a failed run with bun's per-file sections is judged over only the test files the statement names", () => {
		const out = [
			"bun test v1.3.14 (0d9b296a)",
			"",
			"gates/test/manifest-sync.test.ts:",
			"32 | \texpect(missing).toEqual([]);",
			"error: expect(received).toEqual(expected)",
			"(fail) every file under gates/ has an install/manifest.tsv row [1.76ms]",
			"",
			" 160 pass",
			" 1 fail",
			" 810 expect() calls",
			"Ran 161 tests across 4 files. [14.21s]",
		].join("\n");
		const cmd = "bun test surface/test/lane-model.test.ts surface/test/launch.test.ts classifier/test/lab.test.ts gates/test/manifest-sync.test.ts";
		const run = () => new Transcript().edit("ed1", "surface/src/lane-model.ts").bash("b1", cmd, out, 1);
		const scoped = run().yieldReport("y1", "The same rows all pass: 35 pass, 0 fail across `lane-model.test.ts` and `lab.test.ts`.");
		expect(only(judge(scoped), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const failing = run().yieldReport("y1", "The `manifest-sync.test.ts` tests pass.");
		expect(only(judge(failing), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
		const byStem = run().yieldReport("y1", "The manifest-sync tests pass.");
		expect(only(judge(byStem), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
		const whole = run().yieldReport("y1", "All tests pass.");
		expect(only(judge(whole), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
		const sections = ["test/a.test.ts:", "(pass) a > one", "(pass) a > two", "", "test/b.test.ts:", "(fail) b > one", "", " 2 pass", " 1 fail", "Ran 3 tests across 2 files."].join("\n");
		const shown = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts test/b.test.ts", sections, 1).yieldReport("y1", "The tests in `test/a.test.ts` pass.");
		expect(only(judge(shown), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("F. a result attributed to evidence outside the session, naming no tr- run it holds, is UNSUPPORTED citing the window's end", () => {
		const relay = new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 2 pass\n 1 fail", 1).read("r1");
		const row = only(judge(relay.doneBecause("d1", 'Plumb\'s full bun test at e429e96 is green, per Jo\'s "green" on q-muptjn5jjxpwxs.'), "lane"), "T");
		expect(row).toMatchObject({ verdict: "UNSUPPORTED", reason: "attributed to evidence outside the session", cites: ["r1"] });
		const fence = new Transcript().edit("ed1", "src/a.ts").read("r1").yieldReport("y1", "The full suite passes outside the fence (tr-nothere1).");
		expect(only(judge(fence), "T")).toMatchObject({ verdict: "UNSUPPORTED", reason: "attributed to evidence outside the session", cites: ["r1"] });
		const held = new Transcript().read("r1").fullTest("f1", "tr-held1").aside("tr-held1", "red", 9, 1);
		const asideId = held.lastAside;
		expect(only(judge(held.doneBecause("d1", "Full suite tr-held1 is green, per Jo's merge rule."), "lane"), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["f1", `entry:${asideId}`] });
	});
});

// ---------------------------------------------------------------------------------------------
// Review round 1 (REVIEW-r1.md), one synthetic transcript per finding

describe("review round 1 fixes", () => {
	const passing = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", " 4 pass\n 0 fail");
	const slugEdit = () => new Transcript().edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s;", "}"]);

	test("1. runner text in an echo argument or an eval string never run is not a run or a REAL exercise; a runner after a keyword is", () => {
		const echoed = new Transcript().edit("ed1", "src/a.ts").bash("b1", 'echo "bun test test/a.test.ts 1 pass"', "bun test test/a.test.ts 1 pass").yieldReport("y1", "Tests pass.");
		expect(only(judge(echoed), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["ed1"] });
		const looped = new Transcript().edit("ed1", "src/a.ts").bash("b1", "for i in 1; do bun test test/a.test.ts; done", " 4 pass\n 0 fail").yieldReport("y1", "Tests pass.");
		expect(only(judge(looped), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const held = slugEdit()
			.evalJs("ev1", 'const command = "bun test test/slug.test.ts";\nfunction slug(s) { return s.toLowerCase(); }\nslug("A B")', "a b")
			.yieldReport("y1", "slug is verified.");
		expect(only(judge(held), "C")).toMatchObject({ verdict: "FLAG", reason: "copy-only", cites: ["ev1", "ed1"] });
		const printed = slugEdit().evalJs("ev1", 'console.log("bun test test/slug.test.ts")', "bun test test/slug.test.ts").yieldReport("y1", "slug is verified.");
		expect(only(judge(printed), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const ran = slugEdit().evalJs("ev1", 'const command = "bun test test/slug.test.ts";\nconst out = run(command);\nout', " 4 pass\n 0 fail").yieldReport("y1", "slug is verified.");
		expect(only(judge(ran), "C")).toMatchObject({ verdict: "PASS", cites: ["ev1"] });
	});

	test("2. a run that selected no test (matched 0 tests, or a name filter with no counter) is not a REAL exercise for rule C", () => {
		const zero = slugEdit()
			.bash("b1", "bun test test/slug.test.ts -t absent", 'bun test v1.3.14 (0d9b296a)\n\nerror: regex "absent" matched 0 tests. Searched 1 file (skipping 4 tests) [10.00ms]', 1)
			.yieldReport("y1", "slug is verified.");
		expect(only(judge(zero), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const silent = slugEdit().bash("b1", "bun test test/slug.test.ts --test-name-pattern zz", "error: something went wrong", 1).yieldReport("y1", "slug is verified.");
		expect(only(judge(silent), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const evalZero = slugEdit().evalJs("ev1", 'run("bun test test/slug.test.ts -t absent")', 'error: regex "absent" matched 0 tests.').yieldReport("y1", "slug is verified.");
		expect(only(judge(evalZero), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const counted = slugEdit().bash("b1", "bun test test/slug.test.ts -t lower", " 2 pass\n 0 fail").yieldReport("y1", "slug is verified.");
		expect(only(judge(counted), "C")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("3. only an operand that is both in the tree and reaches the edited file makes a run REAL", () => {
		const outsideReach = slugEdit().bash("b1", "bun test /tmp/slug.test.ts test/other.test.ts", " 2 pass\n 0 fail").yieldReport("y1", "slug is fixed.");
		expect(only(judge(outsideReach), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const insideReach = slugEdit().bash("b1", "bun test /tmp/other.test.ts test/slug.test.ts", " 2 pass\n 0 fail").yieldReport("y1", "slug is fixed.");
		expect(only(judge(insideReach), "C")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("4. one git step's no-op never hides another step's tree change; unattributable output counts as an edit", () => {
		const mixed = passing().bash("g1", "git merge branch && git merge main", "Merge made by the 'ort' strategy.\nAlready up to date.").yieldReport("y1", "Tests pass.");
		expect(only(judge(mixed), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
		const short = passing().bash("g1", "git pull origin main && git rebase origin/main", "Already up to date.").yieldReport("y1", "Tests pass.");
		expect(only(judge(short), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
		const status = passing().bash("g1", "git merge origin/main && git status", "Already up to date.\nOn branch wl/x\nYour branch is up to date with 'origin/wl/x'.").yieldReport("y1", "Tests pass.");
		expect(only(judge(status), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("5. a cd after a shell keyword or opener moves the directory for what follows", () => {
		for (const cmd of ["for x in a; do cd /tmp/copy; done; bun test test/a.test.ts", "if true; then cd /tmp/copy; fi; bun test test/a.test.ts", "{ cd /tmp/copy; }; bun test test/a.test.ts"]) {
			const t = passing().bash("b2", cmd, " 3 pass\n 1 fail", 1).yieldReport("y1", "Tests pass.");
			expect({ cmd, row: only(judge(t), "T") }).toMatchObject({ cmd, row: { verdict: "PASS", cites: ["b1"] } });
		}
	});

	test("6. a bare possessive is not attribution; an attributed result or answer is", () => {
		const run = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test", " 3 pass\n 0 fail");
		expect(only(judge(run().yieldReport("y1", "Jo's tests pass in the recorded bun test run.")), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		expect(only(judge(run().yieldReport("y1", "Plumb's README is unchanged and the tests pass.")), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		for (const s of ["The tests pass, per Jo's green answer.", "Plumb's run is green and the tests pass.", "The full suite passes, as reported by the runner."]) {
			expect({ s, row: only(judge(run().yieldReport("y1", s)), "T") }).toMatchObject({ s, row: { verdict: "UNSUPPORTED", reason: "attributed to evidence outside the session", cites: ["b1"] } });
		}
	});

	test("7. a bare stem scopes a failed run only when it is one header's stem; an unresolved scope with the failure elsewhere is UNKNOWN", () => {
		const failure = ["gates/test/manifest-sync.test.ts:", "31 | \texpect(missing).toEqual([]);", "error: expect(received).toEqual(expected)", "(fail) every file under gates/ has an install/manifest.tsv row [1.76ms]", ""];
		const tail = [" 224 pass", " 1 fail", " 966 expect() calls", "Ran 225 tests across 13 files. [16.85s]"];
		const run = (sections: string[]) => new Transcript().edit("ed1", "classifier/extension.ts").bash("b1", "bun test classifier gates/test/manifest-sync.test.ts", ["bun test v1.3.14 (0d9b296a)", "", ...sections, ...failure, ...tail].join("\n"), 1);
		const crosslab = run([]).yieldReport("y1", "Every listed behaviour has a passing test (crosslab 46/46).");
		expect(only(judge(crosslab), "T")).toMatchObject({ verdict: "UNKNOWN", reason: "scope unresolved; the failure is in a file the statement does not name", cites: ["b1"] });
		expect(only(judge(run([]).yieldReport("y1", "All 224 tests pass.")), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
		const shown = run(["classifier/test/crosslab.test.ts:", "(pass) crosslab > one", ""]).yieldReport("y1", "Every listed behaviour has a passing test (crosslab 46/46).");
		expect(only(judge(shown), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const shared = run(["classifier/test/lab.test.ts:", "(pass) lab > one", "", "gates/test/lab.test.ts:", "(pass) lab > two", ""]).yieldReport("y1", "The lab tests pass.");
		expect(only(judge(shared), "T")).toMatchObject({ verdict: "FLAG", reason: "failed-run", cites: ["b1", "ed1"] });
	});

	test("8. `pass` as a noun modifier (`pass and stop variants`) is not a tests-pass claim", () => {
		const row =
			"| ACTION | #3 incomplete production fan-out across a restart | `roundSettled` writes `review-round: … dropped` for each listed member that never spawned. | test classifier/test/crosslab.test.ts:1033-1066 (pass and stop variants; the stop message names the dropped member) |";
		expect(extractStatements(row).map(claimClasses)).toEqual([[]]);
		expect(claimClasses("The pass/fail variants have a test each.")).toEqual([]);
		expect(claimClasses("All tests pass, the pass and stop variants included.")).toEqual(["T"]);
		const t = passing().bash("b2", "bun test", " 3 pass\n 1 fail", 1).yieldReport("y1", row);
		expect(judge(t)).toEqual([]);
	});

	test("9. a git tree-changer counts only in command position: git text in a `bun -e` string is not an edit", () => {
		const quoted = passing()
			.bash("g1", `bun -e 'const c = "git merge branch && git merge main"; console.log(c.split(" && ").length)'`, "2")
			.yieldReport("y1", "Tests pass.");
		expect(only(judge(quoted), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const afterCd = passing().bash("g1", "cd x && git merge main", "Merge made by the ort strategy.").yieldReport("y1", "Tests pass.");
		expect(only(judge(afterCd), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
		const looped = passing().bash("g1", "for b in a; do git rebase main; done", "Successfully rebased and updated refs/heads/wl/x.").yieldReport("y1", "Tests pass.");
		expect(only(judge(looped), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
	});
});

describe("review round 2 fixes", () => {
	const passing = () => new Transcript().edit("ed1", "src/a.ts").bash("b1", "bun test test/a.test.ts", " 4 pass\n 0 fail");
	const slugEdit = () => new Transcript().edit("ed1", "src/slug.ts", ["export function slug(s: string) {", "  return s;", "}"]);

	test("1. an eval runner is REAL only when the eval's output shows it ran; a runner call in a comment is no call", () => {
		const uncalled = slugEdit().evalJs("ev1", 'function demo() { run("bun test test/slug.test.ts") }', "undefined").yieldReport("y1", "slug is verified.");
		expect(only(judge(uncalled), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const shadowed = slugEdit().evalJs("ev1", 'const run = (c) => c;\nrun("bun test test/slug.test.ts")', "bun test test/slug.test.ts").yieldReport("y1", "slug is verified.");
		expect(only(judge(shadowed), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		for (const code of ['// run("bun test test/slug.test.ts")\n1', '/* run("bun test test/slug.test.ts") */ 1']) {
			const commented = slugEdit().evalJs("ev1", code, " 4 pass\n 0 fail").yieldReport("y1", "slug is verified.");
			expect({ code, row: only(judge(commented), "C") }).toMatchObject({ code, row: { verdict: "UNEXERCISED" } });
		}
		const pyCommented = slugEdit()
			.call("ev1", "eval", { language: "py", code: '# subprocess.run("bun test test/slug.test.ts", shell=True)\nprint(1)' }, " 4 pass\n 0 fail", { language: "py" })
			.yieldReport("y1", "slug is verified.");
		expect(only(judge(pyCommented), "C")).toMatchObject({ verdict: "UNEXERCISED" });
		const header = slugEdit().evalJs("ev1", 'run("bun test test/slug.test.ts")', "test/slug.test.ts:\n(pass) slug > lowers [0.10ms]").yieldReport("y1", "slug is verified.");
		expect(only(judge(header), "C")).toMatchObject({ verdict: "PASS", cites: ["ev1"] });
	});

	test("2. output from an out-of-tree git step or an echo never proves an in-tree change", () => {
		const otherTree = passing().bash("g1", "git -C /tmp/other merge branch && git merge main", "Merge made by the 'ort' strategy.\nAlready up to date.").yieldReport("y1", "Tests pass.");
		expect(only(judge(otherTree), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const echoed = passing().bash("g1", "git merge main && echo Merge made by", "Already up to date.\nMerge made by").yieldReport("y1", "Tests pass.");
		expect(only(judge(echoed), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		const changed = passing().bash("g1", "git merge main && echo done", "Merge made by the 'ort' strategy.\ndone").yieldReport("y1", "Tests pass.");
		expect(only(judge(changed), "T")).toMatchObject({ verdict: "FLAG", reason: "no-run-after-edit", cites: ["g1"] });
	});

	test("3. a later zero-match runner never erases an earlier real test in the same call", () => {
		const output = ' 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]\nbun test v1.3.14 (0d9b296a)\n\nerror: regex "absent" matched 0 tests. Searched 1 file (skipping 3 tests) [4.00ms]';
		const t = slugEdit().bash("b1", "bun test test/slug.test.ts; bun test /tmp/other.test.ts -t absent", output, 1).yieldReport("y1", "Tests pass.\nslug is verified.");
		const rows = judge(t);
		expect(only(rows, "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
		expect(only(rows, "C")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});

	test("4. `env` and `time` wrappers with options or assignments still put the runner in command position", () => {
		for (const cmd of ["env -i bun test x.test.ts", "time -p bun test x.test.ts", "env -u HOME -- FOO=1 bun test x.test.ts", "env - PATH=/bin bun test x.test.ts", "time -p env -i bun test x.test.ts"]) {
			expect({ cmd, ok: isTestCommand(cmd) }).toEqual({ cmd, ok: true });
		}
		expect(isTestCommand('env -i echo "bun test x.test.ts"')).toBe(false);
		const t = new Transcript().edit("ed1", "src/a.ts").bash("b1", "env -i bun test test/a.test.ts", " 4 pass\n 0 fail").yieldReport("y1", "Tests pass.");
		expect(only(judge(t), "T")).toMatchObject({ verdict: "PASS", cites: ["b1"] });
	});
});

// ---------------------------------------------------------------------------------------------
// Replay and the CLI

/** Every path under `root` with each file's sha256: the tree's fingerprint. */
function fingerprint(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) {
				out.push(`${p}/`);
				walk(p);
			} else out.push(`${p} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
		}
	};
	walk(root);
	return out;
}

function replayRoot(): { tmp: string; root: string } {
	const tmp = mkdtempSync(join(tmpdir(), "claim-check-replay-"));
	const root = join(tmp, "lanes", "wl-test", "sessions");
	mkdirSync(join(root, "2026-a"), { recursive: true });
	const lane = new Transcript().edit("lane-ed1", "src/a.ts").bash("lane-b1", "bun test", " 3 pass\n 1 fail").doneBecause("lane-d1", "All tests pass.").text("Released.").toString();
	writeFileSync(join(root, "2026-a.jsonl"), lane);
	// A resumed lane: a new header, then the same entries (same entry and tool-call ids).
	writeFileSync(join(root, "2026-b.jsonl"), lane.replace('"id":"s-1"', '"id":"s-2"'));
	const hand = new Transcript().edit("hand-ed1", "src/b.ts").bash("hand-b1", "bun test test/b.test.ts", " 4 pass\n 0 fail").yieldReport("hand-y1", "Tests pass: 4 pass, 0 fail.").toString();
	writeFileSync(join(root, "2026-a", "sl-x--kimi.jsonl"), hand);
	return { tmp, root };
}

describe("replay", () => {
	test("counts by role, a resumed copy's claim once, and the tree is unchanged", async () => {
		const { tmp, root } = replayRoot();
		const before = fingerprint(tmp);
		const report = await replay([root], 0);
		expect(report).toMatchObject({ files: 3, claims: 2, duplicates: 1, sessionsWithClaims: 2 });
		expect(report.counts.lane).toMatchObject({ "T FLAG(failed-run)": 1, "T PASS": 0, "no-claim reports": 1, "no-calls": 0 });
		expect(report.counts.hand).toMatchObject({ "T PASS": 1, "T FLAG(failed-run)": 0 });
		const out: string[] = [];
		expect(await main(["--replay", "--root", root, "--days", "0", "--show", "flag"], (s) => out.push(s))).toBe(0);
		expect(out.join("\n")).toContain("CLAIM CHECK REPLAY  roots: 1  files read: 3  sessions with claims: 2  claims: 2  duplicates skipped: 1");
		expect(out.join("\n")).toContain(`${join(root, "2026-a.jsonl")}:`);
		expect(fingerprint(tmp)).toEqual(before);
	});

	test("the CLI: --replay --root prints the counts and exits 0; a bad root or argument exits 2", () => {
		const { tmp, root } = replayRoot();
		const before = fingerprint(tmp);
		const ok = spawnSync("bun", [SCRIPT, "--replay", "--root", root, "--days", "0"], { encoding: "utf8" });
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("T FLAG(failed-run)");
		expect(ok.stdout).toMatch(/no-claim reports\s+1\s+0\s+0/);
		expect(spawnSync("bun", [SCRIPT, "--replay", "--root", join(tmp, "missing")], { encoding: "utf8" }).status).toBe(2);
		expect(spawnSync("bun", [SCRIPT, "--bogus"], { encoding: "utf8" }).status).toBe(2);
		expect(fingerprint(tmp)).toEqual(before);
	});

	test("the CLI on fixtures: a table, exit 1 on a FLAG and 0 without; --json is one object per row", () => {
		const flagged = spawnSync("bun", [SCRIPT, join(FIXTURES, "t1-c.jsonl")], { encoding: "utf8" });
		expect(flagged.status).toBe(1);
		expect(flagged.stdout).toContain(`FLAG        T failed-run`);
		expect(flagged.stdout).toContain(T1C_RUN);
		const clean = spawnSync("bun", [SCRIPT, join(FIXTURES, "t1-a.jsonl")], { encoding: "utf8" });
		expect(clean.status).toBe(0);
		const json = spawnSync("bun", [SCRIPT, "--json", join(FIXTURES, "t3-a.jsonl")], { encoding: "utf8" });
		const rows = json.stdout.trim().split("\n").map((l) => JSON.parse(l) as Row);
		expect(rows.map((r) => [r.rule, r.verdict, r.reason])).toEqual([
			["C", "FLAG", "copy-only"],
			["C", "FLAG", "copy-only"],
			["C", "FLAG", "copy-only"],
		]);
		expect(rows[0]).toMatchObject({ role: "other", source: "final-text", carrier: "msg:a1814bd5" });
	});
});
