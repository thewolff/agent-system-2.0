// P-11 row 2 (DESIGN-2.0.md:339; C4.7; build question 7 at DESIGN-2.0.md:97): the output-types
// contract is present in every agent's context. Injection, not a gate: the gates extension appends
// the contract to the system prompt in `before_agent_start`, which OMP fires in lanes and, because
// children re-bind the parent's extensions, in hands too. See REPORT.md "Build question 7".
//
// The contract has one source: the public output-types plugin, vendored at plugins/output-types
// (plugins/VENDOR.md). as2 keeps no copy of its own; it injects the plugin's whole reference file,
// so a change to the contract is a re-pin, never an edit here.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Env var naming the contract file; read at every agent start so edits land without a restart. */
export const CONTRACT_ENV = "AGENT_SYSTEM_CONTRACT";
/** The vendored plugin's reference file, relative to the repo root. AGENT_SYSTEM_CONTRACT overrides it. */
export const CONTRACT_RELATIVE = join("plugins", "output-types", "skills", "output-types", "reference.md");
/** Marker that makes the injection idempotent when several prompt layers re-run. */
export const CONTRACT_MARKER = "<!-- p11-row-2: output-types contract -->";

export function contractPath(env: Record<string, string | undefined>): string {
	const override = env[CONTRACT_ENV];
	return override && override.trim() ? override : join(dirname(dirname(dirname(import.meta.dir))), CONTRACT_RELATIVE);
}

/**
 * The system prompt with the contract appended once. A missing file is not silent: the agent gets a
 * line saying the contract could not be loaded and from where, so the gap shows in every transcript.
 */
export function injectContract(systemPrompt: string[], env: Record<string, string | undefined>): string[] {
	if (systemPrompt.some((p) => p.includes(CONTRACT_MARKER))) return systemPrompt;
	const path = contractPath(env);
	const body = existsSync(path)
		? readFileSync(path, "utf8")
		: `The output-types contract could not be loaded from ${path} (set ${CONTRACT_ENV}). Label receipted facts regardless: CLAIM with an inspectable receipt, CITE with a source fetched this session; everything else stays unlabeled.`;
	return [...systemPrompt, `${CONTRACT_MARKER}\n${body}`];
}
