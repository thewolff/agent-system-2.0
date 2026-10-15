// The `bun test` preload (wired by bunfig.toml at the repo root, each module root and each test
// dir): every test process runs against a temp HOME and a temp ledger path, never the developer's
// own `~/.agent-system-2` (PLAN wl-mv4yf3zgf9lm2o § 2 item 1). The guard in ledger/src/locality.ts
// (assertNotLiveLedgerUnderTest) refuses the real home's ledger root, recorded here, under test.
// initTestTmp() runs first: it makes this run's watched temp root and points TMPDIR into it (PLAN
// wl-mv8mof9kktbh1c § 2), so the temp HOME below, and every temp dir after it, lands inside that root.
import { cleanupTestTmp, initTestTmp } from "./tmp";
import { afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_DB_ENV, TEST_ISOLATED_ENV, TEST_REAL_HOME_ENV, TEST_REAL_LEDGER_DB_ENV } from "../src/locality";

initTestTmp();

// A nested run (a test spawning `bun test` with this env) keeps the real values its parent recorded.
if (!process.env[TEST_ISOLATED_ENV]) {
	process.env[TEST_REAL_HOME_ENV] = process.env.HOME ?? "";
	process.env[TEST_REAL_LEDGER_DB_ENV] = process.env[LEDGER_DB_ENV] ?? "";
}
const home = mkdtempSync(join(tmpdir(), "as2-test-home-"));
process.env.HOME = home;
// Not created: a test that wants the default ledger opens it with { create: true }.
process.env[LEDGER_DB_ENV] = join(home, ".agent-system-2", "ledger.db");
process.env[TEST_ISOLATED_ENV] = "1";
// A preload's afterAll runs once, after every test file, on a passing and a failing run; `bun test`
// (1.3.14) emits no process "exit". The temp HOME is an entry of the run root, so cleanupTestTmp
// removes it behind the root's identity check; the run root itself is left for its watchdog (tmp.ts).
afterAll(cleanupTestTmp);
