// The control side of the tmp-cleanup fixtures (ledger/test/tmp-cleanup.test.ts): files the parent test
// reads live outside the fixture's TMPDIR, so they never count as something the run left behind.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** Writes `FIX_READY` (when set) in one rename: this run's tmpdir() plus what the fixture made. */
export function ready(made: Record<string, string> = {}): void {
	const path = process.env.FIX_READY;
	if (!path) return;
	writeFileSync(`${path}.part`, JSON.stringify({ tmpdir: tmpdir(), ...made }));
	renameSync(`${path}.part`, path);
}

/**
 * With `FIX_RELEASE` set, waits until that file exists; else with `FIX_BLOCK` set, until stdin closes. Both
 * wait asynchronously, so signal handlers still run. A nested run needs the file: a `bun test` child given
 * stdin "inherit" sees EOF as soon as its parent is killed.
 */
export async function block(): Promise<void> {
	const release = process.env.FIX_RELEASE;
	if (release) while (!existsSync(release)) await Bun.sleep(20);
	else if (process.env.FIX_BLOCK) await Bun.stdin.text();
}
