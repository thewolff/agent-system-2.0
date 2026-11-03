// T1 (PLAN wl-mvq8x4l6zubxfk "Permanent tests"): opening the ledger starts no child process. Bun
// 1.3.14's spawnSync can lose a child's reap and spin forever (oven-sh/bun#46488), and Ledger.open
// used to spawn `/usr/bin/id -P` (or getent), `df -P` and `/sbin/mount` on every open under test.
// Imports only ../src/index and ../src/locality, so the same file runs against an older tree.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/index";
import { assertLocalPath, assertNotLiveLedgerUnderTest } from "../src/locality";

const scratch = mkdtempSync(join(tmpdir(), "as2-no-spawn-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CHILD_PROCESS_FNS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

test("Ledger.open, a reopen with backups on and both guards start no child process", () => {
	expect(process.env.AS2_TEST_ISOLATED).toBe("1");
	const childProcess = require("node:child_process") as Record<(typeof CHILD_PROCESS_FNS)[number], (...args: unknown[]) => unknown>;
	const spies = {
		"Bun.spawnSync": spyOn(Bun, "spawnSync"),
		"Bun.spawn": spyOn(Bun, "spawn"),
		...Object.fromEntries(CHILD_PROCESS_FNS.map((name) => [`child_process.${name}`, spyOn(childProcess, name)])),
	};
	let calls: Record<string, number>;
	try {
		const path = join(scratch, "ledger", "l.db");
		Ledger.open(path, { create: true }).close();
		Ledger.open(path).close();
		assertLocalPath(join(scratch, "not", "yet", "l.db"));
		assertNotLiveLedgerUnderTest(join(scratch, "l.db"));
	} finally {
		calls = Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));
		for (const spy of Object.values(spies)) spy.mockRestore();
	}
	expect(calls).toEqual(Object.fromEntries(Object.keys(spies).map((name) => [name, 0])));
});
