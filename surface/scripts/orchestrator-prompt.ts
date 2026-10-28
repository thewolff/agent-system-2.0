// orchestrator-prompt: the orchestrator's launch-time system-prompt addition, which `bin/as2` passes
// to omp as `--append-system-prompt <file>`. It holds the voice section and the output-types
// contract (the vendored public plugin's reference, plugins/VENDOR.md) as the exact strings a turn would append (surface/src/session.ts `voiceSection`,
// gates/src/rows/r02-contract.ts `injectContract`), so both extensions find them in the base prompt
// and leave every turn's system prompt unchanged. OMP runs `before_agent_start` only on a turn Jo
// types, never on an aside-started one (a wake push, a needs-you, a notice); with the two sections in
// the base prompt both kinds of turn send the same system bytes, and the first turn Jo types after a
// restart no longer rewrites the whole conversation into the prompt cache.
//
//   bun surface/scripts/orchestrator-prompt.ts <out-file>
//
// The paths are the ones the extensions read: AGENT_SYSTEM_VOICE or voice/VOICE.md, and
// AGENT_SYSTEM_CONTRACT or plugins/output-types/skills/output-types/reference.md, in this checkout. Edits to either file reach the
// orchestrator at its next launch.
// Exit: 0 written · 1 a source file is missing, named on stderr (omp reads a missing path as literal
// prompt text, so as2 refuses to launch rather than pass one) · 2 usage
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONTRACT_ENV, contractPath, injectContract } from "../../gates/src/rows/r02-contract";
import { voicePath, voiceSection } from "../src/session";
import { VOICE_ENV } from "../src/types";

/** The file's text, or what is missing (one line each, naming the path and its env override). */
export function orchestratorPrompt(env: Record<string, string | undefined>): { text: string } | { missing: string[] } {
	const voice = voicePath(env);
	const contract = contractPath(env);
	const missing = [
		...(existsSync(voice) ? [] : [`the voice document is missing at ${voice} (set ${VOICE_ENV})`]),
		...(existsSync(contract) ? [] : [`the output-types contract is missing at ${contract} (set ${CONTRACT_ENV})`]),
	];
	if (missing.length > 0) return { missing };
	return { text: `${voiceSection({ path: voice, text: readFileSync(voice, "utf8") })}\n\n${injectContract([], env)[0]}` };
}

if (import.meta.main) {
	const out = process.argv[2];
	if (!out || process.argv.length > 3) {
		process.stderr.write("usage: bun surface/scripts/orchestrator-prompt.ts <out-file>\n");
		process.exit(2);
	}
	const rendered = orchestratorPrompt(process.env);
	if ("missing" in rendered) {
		for (const line of rendered.missing) process.stderr.write(`as2: refusing to launch: ${line}\n`);
		process.exit(1);
	}
	mkdirSync(dirname(out), { recursive: true });
	// Whole or not at all: a launch racing this one reads either the old file or the new one.
	const tmp = `${out}.tmp.${process.pid}`;
	writeFileSync(tmp, rendered.text);
	renameSync(tmp, out);
}
