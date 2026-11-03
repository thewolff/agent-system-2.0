// `as2 routing` end to end (PLAN wl-mv71x5rwdu7eo0 rev 4 § 2.1): the real bin/as2 under sh execs
// surface/scripts/routing-report.ts on a fixture ledger in a temp dir (`--ledger`), with a temp HOME and only bun's
// directory and the system dirs on PATH; never the live ledger. Every run is awaited to its real exit (Bun.spawnSync).
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clock, tempLedger, tmp, workloadWithSlice } from "./helpers";

const REPO = resolve(import.meta.dir, "..", "..");
const AS2 = join(REPO, "bin", "as2");

function fixtureLedger(): string {
	const c = clock("2026-10-13T18:00:00.000Z");
	const { ledger, path } = tempLedger(c.now);
	const { wl, sl } = workloadWithSlice(ledger);
	const root = join(tmp("routing-bin"), "sessions", "s");
	const rows: [string, "change-large" | "change-small" | "judge", "strong" | "standard" | "deep"][] = [
		["2026-10-13T19:00:00.000Z", "change-large", "strong"],
		["2026-10-13T19:01:00.000Z", "change-small", "standard"],
		["2026-10-13T19:02:00.000Z", "judge", "deep"],
		["2026-10-13T19:04:00.000Z", "change-large", "strong"],
	];
	let n = 0;
	for (const [at, kind, tier] of rows) {
		c.at(at);
		ledger.recordRouting({
			by: "lane-a", workloadId: wl, sliceId: sl, sessionRoot: root, agentId: `hand-${++n}`, kind, confidence: 0.9, probabilities: { [kind]: 0.9 },
			classifiedTier: tier, tier, models: ["anthropic/claude-opus-5-5"], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: ["anthropic/claude-opus-5-5"],
		});
	}
	ledger.close();
	return path;
}

function as2(...args: string[]): { code: number | null; out: string; err: string } {
	const home = tmp("routing-bin-home");
	mkdirSync(home, { recursive: true });
	const r = Bun.spawnSync(["sh", AS2, ...args], {
		cwd: home,
		env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("as2 routing", () => {
	test("the header line on a fixture ledger, --until exclusive", () => {
		const db = fixtureLedger();
		const r = as2("routing", "--ledger", db, "--until", "2026-10-13T19:04:00Z");
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		const lines = r.out.split("\n");
		expect(lines[0]).toBe("3 rows · jev 3 · change-large 1 of 2 code rows");
		// No session file exists for any hand: every hand is n/a and counted, never a zero.
		expect(lines[1]).toBe("hands 3 · cost read 0 · n/a 3 (session file missing 3, unreadable 0, incomplete 0) · no hand 0");
	});

	test("--json prints the report object", () => {
		const db = fixtureLedger();
		const r = as2("routing", "--ledger", db, "--json", "--split", "2026-10-13T19:01:30Z");
		expect(r.code).toBe(0);
		const report = JSON.parse(r.out) as { all: { rows: number }; split: { before: { rows: number }; after: { rows: number } } };
		expect([report.all.rows, report.split.before.rows, report.split.after.rows]).toEqual([4, 2, 2]);
	});

	test("a bad argument exits 2 and names the argument", () => {
		const db = fixtureLedger();
		const cases: [string[], string][] = [
			[["--until", "yesterday"], "--until"],
			[["--since"], "--since needs a value"],
			[["--workload", "x"], "--workload"],
			[["--split", "2026-13-45"], "--split"],
			[["--bogus"], "--bogus"],
			[["--json", "--json"], "--json given twice"],
			[["--since", "2026-10-14", "--until", "2026-10-13"], "--since"],
		];
		for (const [args, named] of cases) {
			const r = as2("routing", "--ledger", db, ...args);
			expect(r.code).toBe(2);
			expect(r.err).toContain(named);
			expect(r.err).toContain("usage: bun surface/scripts/routing-report.ts");
			expect(r.out).toBe("");
		}
	});

	test("a ledger that does not exist exits 1, naming the path", () => {
		const missing = join(tmp("routing-bin-none"), "ledger.db");
		const r = as2("routing", "--ledger", missing);
		expect(r.code).toBe(1);
		expect(r.err).toContain(missing);
	});

	test("as2 --help names the routing word", () => {
		const r = as2("--help");
		expect(r.code).toBe(0);
		expect(r.out).toContain("as2 routing [--since <ISO>] [--until <ISO>] [--split <ISO>] [--workload <wl>] [--ledger <path>] [--json]");
	});
});
