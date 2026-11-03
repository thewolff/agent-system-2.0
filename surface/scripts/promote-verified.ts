#!/usr/bin/env bun
// Jo's reserved schema transition: stop the tick, migrate the ledger, promote a green believable
// commit, then restart. This command never migrates the live ledger and never overrides a verdict.
import { promoteVerified, START_EXIT } from "./test-runner";

export function main(args: string[]): number {
	if (args.length !== 1 || !/^[0-9a-f]{40}$/.test(args[0]!)) {
		process.stderr.write("usage: promote-verified.ts <sha> (green believable main verdict required)\n");
		return START_EXIT.usage;
	}
	return promoteVerified(args[0]!, true);
}
if (import.meta.main) {
	try { process.exitCode = main(process.argv.slice(2)); }
	catch (e) {
		process.stderr.write(`promote-verified: ${e instanceof Error ? e.message : String(e)}; repair the reported promotion step and retry\n`);
		process.exitCode = START_EXIT.failed;
	}
}
