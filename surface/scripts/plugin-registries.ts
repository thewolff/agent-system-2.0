#!/usr/bin/env bun
// `bun surface/scripts/plugin-registries.ts check [--cwd <dir>]` (PLAN wl-mv8k0fby51uakg D7, jo-issues#51): whether an
// OMP session started in <dir> (default: this process's cwd) takes a plugin from an OMP registry at a version other
// than an active Claude Code entry's (surface/src/plugin-registries.ts `findDisagreements`). HOME and the env are this
// process's. Exit 0 and print nothing when they agree. Exit 1 on any disagreement: one line per plugin with both
// versions and both registry paths, then per plugin the two match commands and the two disable commands, on stderr.
// Exit 2 when a registry file holds text OMP would not read, naming it. bin/as2 runs it before every orchestrator start
// (`as2`, `as2 --print`) and as `as2 plugins`; a lane launch does not.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { findDisagreements, fixCommands, MalformedRegistryError, type RegistryInputs } from "../src/plugin-registries";

const USAGE = "usage: plugin-registries.ts check [--cwd <dir>]";

export function main(argv: readonly string[], env: Record<string, string | undefined> = process.env, err: (s: string) => void = (s) => process.stderr.write(s)): number {
	const [command, ...rest] = argv;
	const withCwd = rest.length === 2 && rest[0] === "--cwd" && !!rest[1];
	if (command !== "check" || (rest.length !== 0 && !withCwd)) {
		err(`as2 plugins: ${USAGE}\n`);
		return 2;
	}
	const inputs: RegistryInputs = { home: env.HOME || homedir(), env, cwd: withCwd ? resolve(rest[1]!) : process.cwd() };
	let found;
	try {
		found = findDisagreements(inputs);
	} catch (e) {
		if (!(e instanceof MalformedRegistryError)) throw e;
		err(`as2 plugins: ${e.path} is not a plugin registry OMP can read (malformed JSON, or no numeric "version" and "plugins" map); fix or remove it\n`);
		return 2;
	}
	if (found.length === 0) return 0;
	err(`as2: the OMP and Claude Code plugin registries disagree on ${found.length === 1 ? "a plugin version" : `${found.length} plugin versions`}; nothing was started\n`);
	for (const d of found) err(`  ${d.id}: OMP ${d.ompVersion} (${d.ompPath}) vs Claude ${d.claudeVersion} (${d.claudePath})\n`);
	for (const d of found) {
		const fix = fixCommands(d, inputs);
		err(`fix ${d.id}, one of:\n`);
		err(`  match Claude:      ${fix.omp}\n`);
		err(`  match OMP:         ${fix.claude}\n`);
		err(`  disable in OMP:    ${fix.ompDisable}\n`);
		err(`  disable in Claude: ${fix.claudeDisable}\n`);
	}
	err("(the match commands take no version: omp plugin install and claude plugin update install the marketplace's current one, which can still differ; check the version each reports.\n");
	err(" The disable commands are deterministic: a disabled plugin counts as absent here, as it does in OMP. Claude's, once it succeeds, leaves the plugin no active Claude entry to disagree with; it refuses with \"already disabled\" when Claude's settings never enabled the plugin, and Claude Code is not loading it then, but OMP still reads Claude's entry, so use the OMP one. OMP's stops OMP loading the plugin from that registry and removes only that registry's entry: a lower OMP entry for the same plugin (the user registry's, under a project one) then counts, and can disagree with Claude in its own right. After either, run as2 again: it runs this check again.)\n");
	return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
