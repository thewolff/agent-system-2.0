// Runs the nightly Drive backup job's zsh fixture suites (install/drive-backup/test-*.zsh, jo-issues #300) under bun
// test, so they run in the lane fence (P-11 row 10 refuses a direct zsh run of the suite that drives /usr/bin/sqlite3)
// and on the Mac full suite. One concurrent test per suite file, found when this file loads: a suite added later runs with no
// edit here. Each suite runs as `/bin/zsh <suite>` under its own temp root, with HOME and TMPDIR inside it, a minimal
// PATH, AS2_BUN (the bun running this file) and AS2_REPO (this checkout); it must exit 0 and print `RESULT: 0
// failure(s)`. fake-drive-fixture.zsh keeps AS2_BUN for the parts that run bun themselves (the lane round trip,
// test-fake-drive-lanes.zsh) and unsets it for the job, so the other parts' nights run as a manual run. The root is
// removed on a pass and kept on a failure, its path in the assertion message. The suites are deterministic (fake
// clock, proof hook, run stamp; no fixed waits); the timeouts below are only hang guards. macOS only: the suites and
// the job use macOS stat/md5/xattr/osascript and the Drive for desktop layout (profile/config.yml testRunner.macOnly).
// Every suite it runs, and every file in install/drive-backup a suite sources, must have an install/manifest.tsv row
// and no `sleep` command (PLAN wl-mw14khl4uf388q R18, R19; review r3 R3-4): timing-lint reads only *.test.ts and
// manifest-sync does not walk install/, so this file is where a shell suite's sleep or missing row fails.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const DIR = join(REPO, "install", "drive-backup");
const SUITES = readdirSync(DIR).filter((n) => /^test-.*\.zsh$/.test(n)).sort();
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// Hang guards only, far above a passing run: the spawn is killed at the first, and bun's test timeout sits above it.
const HANG_GUARD_MS = 600_000;

test("install/drive-backup has at least one test-*.zsh suite", () => {
	expect(SUITES.length).toBeGreaterThan(0);
});

/** The suite and every install/drive-backup file it sources (`source $HERE/<name>` or `source "$HERE/<name>"`). */
function scanned(suite: string): string[] {
	const text = readFileSync(join(DIR, suite), "utf8");
	const sourced = [...text.matchAll(/^\s*(?:source|\.)\s+"?\$(?:\{HERE\}|HERE)\/([\w.-]+)"?/gm)].map((m) => m[1]!);
	return [suite, ...new Set(sourced)];
}

/** Whether a shell line runs a sleep command: its comment is dropped first, so prose about sleeping does not count. */
const runsSleep = (line: string): boolean => /(^|[\s;&|({`'"])(?:\/bin\/)?sleep\s+[\d.$"'(]/.test(line.replace(/(^|\s)#.*$/, ""));

function sleepLines(file: string): string[] {
	return readFileSync(join(DIR, file), "utf8")
		.split("\n")
		.flatMap((l, i) => (runsSleep(l) ? [`${file}:${i + 1}: ${l.trim()}`] : []));
}

test("every test-*.zsh suite run here, and every file it sources, has an install/manifest.tsv row and runs no sleep", () => {
	const rows = new Set(
		readFileSync(join(REPO, "install", "manifest.tsv"), "utf8")
			.split("\n")
			.filter((l) => l !== "" && !l.startsWith("#"))
			.map((l) => l.split("\t")[0]!),
	);
	const files = [...new Set(SUITES.flatMap(scanned))].sort();
	expect(files).toContain("fake-drive-fixture.zsh");
	expect(files.filter((f) => !rows.has(`install/drive-backup/${f}`)).map((f) => `install/drive-backup/${f} has no install/manifest.tsv row`)).toEqual([]);
	expect(files.flatMap(sleepLines)).toEqual([]);
});

test("the sleep check finds a sleep command and ignores prose and comments", () => {
	expect(runsSleep("sleep 1")).toBe(true);
	expect(runsSleep("  x && /bin/sleep 0.5")).toBe(true);
	expect(runsSleep('(sleep "$n")')).toBe(true);
	expect(runsSleep("# nothing here sleeps or sleep 5 in a comment")).toBe(false);
	expect(runsSleep('check "stale heartbeat flagged with the sleep/power-off wording" x')).toBe(false);
	expect(runsSleep("zselect -t 1")).toBe(false);
});

// The suites are independent (each its own temp root, HOME, TMPDIR, state and lock), so they run as concurrent tests:
// a foreground `bun test` of this file takes about as long as its slowest suite, not their sum. The full-suite runner
// passes --max-concurrency=1, which keeps them serial there.
for (const suite of SUITES) {
	test.concurrent.skipIf(process.platform !== "darwin")(`${suite} passes (macOS only: macOS stat/md5/xattr/osascript and the Drive for desktop layout)`, async () => {
		const root = mkdtempSync(join(tmpdir(), "as2-drive-backup-"));
		const home = join(root, "home");
		const tmp = join(root, "tmp");
		mkdirSync(home);
		mkdirSync(tmp);
		const p = Bun.spawn(["/bin/zsh", join(DIR, suite)], {
			cwd: root,
			env: { HOME: home, TMPDIR: tmp, PATH, LANG: "en_US.UTF-8", AS2_BUN: process.execPath, AS2_REPO: REPO },
			stdout: "pipe",
			stderr: "pipe",
			timeout: HANG_GUARD_MS,
		});
		const [out, err, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		const failures = out.split("\n").filter((l) => l.startsWith("FAIL:") || l.startsWith("guard:"));
		const passed = exitCode === 0 && /^RESULT: 0 failure\(s\)$/m.test(out);
		if (passed) rmSync(root, { recursive: true, force: true });
		expect(
			passed,
			`${suite}: exit ${exitCode}${p.signalCode ? ` (signal ${p.signalCode})` : ""}; temp root kept at ${root}\n` +
				`${failures.join("\n")}\n--- last output ---\n${out.split("\n").slice(-40).join("\n")}\n--- stderr ---\n${err.slice(-4000)}`,
		).toBe(true);
	}, HANG_GUARD_MS + 30_000);
}
