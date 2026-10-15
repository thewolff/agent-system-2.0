// tmp-cleanup fixture: an inline `mkdtempSync(join(tmpdir(), …))` dir with a file in it, the shape most
// test files use. FIX_MARKER: written when the test body runs. FIX_BLOCK: wait for stdin to close.
// FIX_FAIL: the test fails.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, ready } from "./io";

test("tmp-cleanup fixture: an inline temp dir", async () => {
	if (process.env.FIX_MARKER) writeFileSync(process.env.FIX_MARKER, "ran\n");
	const made = mkdtempSync(join(tmpdir(), "fixture-inline-"));
	writeFileSync(join(made, "data.txt"), "fixture data\n");
	ready({ made });
	await block();
	expect(process.env.FIX_FAIL ? "failed" : "ok").toBe("ok");
}, 120_000);
