// The incidental-timing check and its ratchet (.ai/decision-log/2026-10-28--0840--plumb--tests-depend-on-timing-only-when-timing-is-under-test.md).
// Jo's rule: a test may depend on timing only when timing is the thing under test. The checker (surface/src/timing-lint.ts,
// whose header defines every pattern and the opt-out) is tested here against the fixtures in surface/test/fixtures/timing-lint/;
// then every *.test.ts in the repository is scanned and held to surface/test/timing-baseline.tsv, which can only shrink.
// This file is in testRunner.fastSmoke (profile/config.yml), so every pull request's fast check runs it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { counts, type Finding, lex, parseBaseline, PATTERNS, ratchet, scan } from "../src/timing-lint";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures", "timing-lint");
const BASELINE = join(import.meta.dir, "timing-baseline.tsv");
// The baseline's total when it was cut (2026-10-28, origin/main 4c1a6e5: 93 findings in 43 rows over 24 files), lowered
// to 91 when main's stuck-detect repair (d7f6d63b) removed one clock-deadline and one sleep. Lower it as rows are fixed;
// raising it is a deliberate edit with a dated comment, the same discipline as the bounds in tiers/test/size.test.ts.
const BASELINE_CEILING = 91;

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** The `//! a b` marks of a fixture: line number → the patterns that line must give, in order. */
function marks(src: string): Map<number, string[]> {
	const out = new Map<number, string[]>();
	src.split("\n").forEach((l, i) => {
		const m = /\/\/!\s*([a-z -]+)\s*$/.exec(l);
		if (m) out.set(i + 1, m[1]!.trim().split(/\s+/));
	});
	return out;
}

/** Findings grouped by line, each line's patterns sorted, for comparison with `marks`. */
function byLine(findings: Finding[]): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const f of findings) out.set(f.line, [...(out.get(f.line) ?? []), f.pattern]);
	for (const [k, v] of out) out.set(k, v.sort());
	return out;
}

const sortedMarks = (src: string) => new Map([...marks(src)].map(([k, v]) => [k, [...v].sort()]));

describe("the checker, on its fixtures", () => {
	test("positive.txt: every marked line gives exactly its patterns, and no unmarked line gives any", () => {
		const src = fixture("positive.txt");
		const r = scan(src);
		expect(r.problems).toEqual([]);
		expect(byLine(r.findings)).toEqual(sortedMarks(src));
		expect(new Set(r.findings.map((f) => f.pattern))).toEqual(new Set(PATTERNS));
	});

	test("negative.txt: no finding and no problem", () => {
		const r = scan(fixture("negative.txt"));
		expect(r.findings).toEqual([]);
		expect(r.problems).toEqual([]);
	});

	test("opt-out.txt: well-formed opt-outs with their fake clock in use cover a whole test, a line, the line below, and a describe", () => {
		const r = scan(fixture("opt-out.txt"));
		expect(r.findings).toEqual([]);
		expect(r.problems).toEqual([]);
		expect(r.optedOut).toBe(5);
	});

	test("opt-out-bad.txt: each bad opt-out is reported, and its finding stands", () => {
		const src = fixture("opt-out-bad.txt");
		const lines = src.split("\n");
		const expected = lines.flatMap((l, i) => {
			const m = /^\s*\/\/ expect-problem: (.+)$/.exec(l);
			return m ? [{ line: i + 2, words: m[1]! }] : [];
		});
		const r = scan(src);
		expect(r.problems.map((p) => p.line)).toEqual(expected.map((e) => e.line));
		for (const [i, e] of expected.entries()) expect(r.problems[i]!.problem).toContain(e.words);
		expect(byLine(r.findings)).toEqual(sortedMarks(src));
	});

	test("the lexer blanks comments and literal bodies but keeps template expressions and every line break", () => {
		const src = 'a("Bun.sleep(1)"); /* x\ny */ b(`t ${c("z")} u`); d(/re\\//); // e\n';
		const { code, comments } = lex(src);
		expect(code.length).toBe(src.length);
		expect(code.split("\n").length).toBe(src.split("\n").length);
		expect(code).not.toContain("Bun.sleep");
		expect(code).toContain("${c(");
		expect(code).not.toContain("re\\/");
		expect(comments).toEqual([{ line: 2, text: " e", ownLine: false }]);
	});
});

describe("the ratchet logic", () => {
	const base = (rows: string) => parseBaseline(`# c\nfile\tpattern\tcount\n${rows}`);

	test("a malformed baseline is reported: header, columns, pattern, count, order, duplicates", () => {
		expect(parseBaseline("f\tp\n").errors[0]).toContain("header");
		expect(base("a.test.ts\tsleep\n").errors[0]).toContain("3 tab-separated columns");
		expect(base("a.test.ts\tnap\t1\n").errors[0]).toContain("unknown pattern nap");
		expect(base("a.test.ts\tsleep\t0\n").errors[0]).toContain("not a positive integer");
		expect(base("b.test.ts\tsleep\t1\na.test.ts\tsleep\t1\n").errors).toContain("rows are not sorted by file then pattern");
		expect(base("a.test.ts\tsleep\t1\na.test.ts\tsleep\t2\n").errors).toContain("a file and pattern appear on more than one row");
		expect(base("a.test.ts\tsleep\t2\na.test.ts\ttimer\t1\n").errors).toEqual([]);
	});

	test("a new offender fails, a fixed one fails until its row is lowered or deleted, an exact match passes", () => {
		const { rows } = base("a.test.ts\tsleep\t2\nb.test.ts\ttimer\t1\n");
		const where = (k: string) => `at ${k}`;
		expect(ratchet(new Map([["a.test.ts\tsleep", 2], ["b.test.ts\ttimer", 1]]), rows, where)).toEqual([]);
		const grown = ratchet(new Map([["a.test.ts\tsleep", 3], ["b.test.ts\ttimer", 1], ["c.test.ts\trace", 1]]), rows, where);
		expect(grown).toHaveLength(2);
		expect(grown[0]).toStartWith("new incidental timing: a.test.ts has 3 sleep finding(s), the baseline allows 2");
		expect(grown[1]).toStartWith("new incidental timing: c.test.ts has 1 race finding(s), the baseline allows 0");
		const shrunk = ratchet(new Map([["a.test.ts\tsleep", 1]]), rows, where);
		expect(shrunk).toEqual([
			"fixed incidental timing: a.test.ts has 1 sleep finding(s), the baseline still allows 2; lower to 1 its row in surface/test/timing-baseline.tsv",
			"fixed incidental timing: b.test.ts has 0 timer finding(s), the baseline still allows 1; delete its row in surface/test/timing-baseline.tsv",
		]);
	});
});

/** Every *.test.ts under the repository, skipping dot-directories (.git, .tmp, .omp) and node_modules. */
function testFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.name.startsWith(".") || e.name === "node_modules") return [];
		const p = join(dir, e.name);
		if (e.isDirectory()) return testFiles(p);
		return e.isFile() && e.name.endsWith(".test.ts") ? [p] : [];
	});
}

describe("the repository's test files (the ratchet)", () => {
	const byFile = new Map<string, Finding[]>();
	const problems: string[] = [];
	for (const path of testFiles(REPO).sort()) {
		const file = relative(REPO, path);
		const r = scan(readFileSync(path, "utf8"));
		if (r.findings.length > 0) byFile.set(file, r.findings);
		for (const p of r.problems) problems.push(`${file}:${p.line}: ${p.problem}`);
	}
	const baseline = parseBaseline(readFileSync(BASELINE, "utf8"));

	test("surface/test/timing-baseline.tsv is well formed and within its ceiling", () => {
		expect(baseline.errors).toEqual([]);
		expect(baseline.rows.reduce((n, r) => n + r.count, 0)).toBeLessThanOrEqual(BASELINE_CEILING);
	});

	test("every timing-under-test opt-out is well formed, names a fake clock in use, and covers a finding", () => {
		expect(problems).toEqual([]);
	});

	test("no test depends on timing beyond the baseline, and every fixed offender has left it", () => {
		const where = (key: string) => {
			const [file, pattern] = key.split("\t") as [string, string];
			return (byFile.get(file) ?? []).filter((f) => f.pattern === pattern).map((f) => `${file}:${f.line} ${f.text}`).join("; ");
		};
		expect(ratchet(counts(byFile), baseline.rows, where)).toEqual([]);
	});
});
