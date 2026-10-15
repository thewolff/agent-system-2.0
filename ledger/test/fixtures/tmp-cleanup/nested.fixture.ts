// tmp-cleanup fixture: a `bun test` that starts a nested `bun test` (inline.fixture.ts, blocking, with the
// real preload) and waits for it. FIX_NESTED_ENV=full gives the nested run `process.env`; curated gives it
// only PATH, HOME and TMPDIR (the live-ledger-guard.test.ts shape) plus its fixture controls.
// FIX_NESTED_READY: the nested run's ready file. FIX_NESTED_RELEASE: the file whose creation releases the
// nested run; the parent test makes it, whether or not this run is still alive.
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ready } from "./io";

const PRELOAD = join(import.meta.dir, "..", "..", "isolate-preload.ts");

test("tmp-cleanup fixture: a nested bun test", async () => {
	const nestedReady = process.env.FIX_NESTED_READY!;
	const controls = { FIX_READY: nestedReady, FIX_RELEASE: process.env.FIX_NESTED_RELEASE! };
	const env =
		process.env.FIX_NESTED_ENV === "curated"
			? { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", ...controls }
			: { ...process.env, ...controls };
	const nested = Bun.spawn([process.execPath, "test", "--preload", PRELOAD, join(import.meta.dir, "inline.fixture.ts")], {
		cwd: import.meta.dir,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	while (!existsSync(nestedReady) && nested.exitCode === null) await Bun.sleep(20);
	ready();
	await nested.exited;
}, 120_000);
