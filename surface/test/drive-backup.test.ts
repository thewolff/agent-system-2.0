// Runs the nightly Drive backup job's zsh fixture suites (install/drive-backup/test-*.zsh, jo-issues #300) under bun
// test, so they run in the lane fence (P-11 row 10 refuses a direct zsh run of the suite that drives /usr/bin/sqlite3)
// and on the Mac full suite. One test per suite file, found when this file loads: a suite added later runs with no
// edit here. Each suite runs as `/bin/zsh <suite>` under its own temp root, with HOME and TMPDIR inside it and a minimal
// PATH; it must exit 0 and print `RESULT: 0 failure(s)`. The root is removed on a pass and kept on a failure, its path
// in the assertion message. The suites are deterministic (fake clock, proof hook, run stamp; no fixed waits); the
// timeouts below are only hang guards. macOS only: the suites and the job use macOS stat/md5/xattr/osascript and the
// Drive for desktop layout (profile/config.yml testRunner.macOnly).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "..", "install", "drive-backup");
const SUITES = readdirSync(DIR).filter((n) => /^test-.*\.zsh$/.test(n)).sort();
const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// Hang guards only, far above a passing run: the spawn is killed at the first, and bun's test timeout sits above it.
const HANG_GUARD_MS = 600_000;

test("install/drive-backup has at least one test-*.zsh suite", () => {
	expect(SUITES.length).toBeGreaterThan(0);
});

for (const suite of SUITES) {
	test.skipIf(process.platform !== "darwin")(`${suite} passes (macOS only: macOS stat/md5/xattr/osascript and the Drive for desktop layout)`, () => {
		const root = mkdtempSync(join(tmpdir(), "as2-drive-backup-"));
		const home = join(root, "home");
		const tmp = join(root, "tmp");
		mkdirSync(home);
		mkdirSync(tmp);
		const r = Bun.spawnSync(["/bin/zsh", join(DIR, suite)], {
			cwd: root,
			env: { HOME: home, TMPDIR: tmp, PATH, LANG: "en_US.UTF-8" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: HANG_GUARD_MS,
		});
		const out = r.stdout.toString();
		const err = r.stderr.toString();
		const failures = out.split("\n").filter((l) => l.startsWith("FAIL:") || l.startsWith("guard:"));
		const passed = r.exitCode === 0 && /^RESULT: 0 failure\(s\)$/m.test(out);
		if (passed) rmSync(root, { recursive: true, force: true });
		expect(
			passed,
			`${suite}: exit ${r.exitCode}${r.signalCode ? ` (signal ${r.signalCode})` : ""}; temp root kept at ${root}\n` +
				`${failures.join("\n")}\n--- last output ---\n${out.split("\n").slice(-40).join("\n")}\n--- stderr ---\n${err.slice(-4000)}`,
		).toBe(true);
	}, HANG_GUARD_MS + 30_000);
}
