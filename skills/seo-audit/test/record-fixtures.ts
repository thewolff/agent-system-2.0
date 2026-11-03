// Re-records the rendered evidence the tests replay: for every fixture that renders, serve it and run audit.ts with
// `--record-rendered <fixture>/rendered --chrome-no-sandbox` against its loopback origin. Needs system Chrome
// (CHROME_PATH or the default macOS path); the tests themselves never launch it.
//
//   bun skills/seo-audit/test/record-fixtures.ts [fixture …]
//
// Commit the rendered/ directories it writes. Lighthouse is not recorded here (no fixture in this family reads lab
// data); a family that needs it adds `--record-lhr <fixture>/lhr.json` for its fixture.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type AuditRun, FIXTURES_DIR, auditFixture, fixtureNames, loadServe } from "./harness.ts";

const wanted = process.argv.slice(2);
let failed = 0;
for (const name of wanted.length ? wanted : fixtureNames()) {
	const dir = join(FIXTURES_DIR, name);
	if (loadServe(dir).audit.noRender) {
		console.log(`${name}: --no-render, skipped`);
		continue;
	}
	rmSync(join(dir, "rendered"), { recursive: true, force: true });
	const started = Date.now();
	// auditFixture fails when the fixture's port cannot be acquired (harness.ts ACQUIRE_DEADLINE_MS and its retry
	// bounds); that fixture is reported and counted, and the rest are still recorded.
	let run: AuditRun;
	try {
		run = await auditFixture(name, "record");
	} catch (e) {
		failed++;
		console.log(`${name}: not recorded: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
		continue;
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (run.code !== 0) {
		failed++;
		console.log(`${name}: audit exited ${run.code} after ${seconds} s\n${run.stderr}`);
		continue;
	}
	rmSync(run.out, { recursive: true, force: true });
	console.log(`${name}: recorded in ${seconds} s`);
}
process.exit(failed ? 1 : 0);
