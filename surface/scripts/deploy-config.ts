#!/usr/bin/env bun
// Reinstall preserves declarations, never acceptance: the newest surface policy row still decides.
import { existsSync, readFileSync } from "node:fs";
import { canonicalJson, readPolicySection } from "../../gates/src/deploy-risk";

function mapping(text: string, what: string): Record<string, unknown> {
	const value: unknown = Bun.YAML.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is not a YAML mapping; nothing written`);
	return value as Record<string, unknown>;
}

/** Carry only the installed deploy section; fail closed rather than silently discard declarations. */
export function carryDeployConfig(rendered: string, installed: string | null): string {
	const fresh = mapping(rendered, "rendered config");
	if (installed === null) return rendered;
	const old = mapping(installed, "installed config");
	if (!("deploy" in old)) return rendered;
	const before = readPolicySection(installed);
	if (!before.ok || !before.parsed.ok) throw new Error(`installed deploy policy is unreadable; nothing written: ${!before.ok ? before.error : !before.parsed.ok ? before.parsed.error : ""}`);
	// Template spelling is deliberately narrow; verify semantic boundaries after the text edit.
	const blocks = [...rendered.matchAll(/^deploy:[^\n]*(?:\n(?:[ \t][^\n]*|[ \t]*))*\n?/gm)];
	if (blocks.length !== 1) throw new Error("rendered config must have exactly one deploy block; nothing written");
	if (canonicalJson(fresh.deploy) === canonicalJson(old.deploy)) return rendered;
	const block = blocks[0]!;
	const replacement = Bun.YAML.stringify({ deploy: old.deploy }, null, 2).trimEnd() + "\n";
	const out = rendered.slice(0, block.index) + replacement + rendered.slice(block.index! + block[0].length);
	const after = mapping(out, "carried config");
	const { deploy: _fresh, ...rest } = fresh;
	const { deploy: _carried, ...afterRest } = after;
	const policy = readPolicySection(out);
	if (canonicalJson(rest) !== canonicalJson(afterRest) || !policy.ok || policy.hash !== before.hash) throw new Error("deploy carry changed policy hash or another config section; nothing written");
	return out;
}

if (import.meta.main) {
	try {
		if (process.argv.length !== 4 || process.argv[2] !== "carry") throw new Error("usage: deploy-config.ts carry <installed-config>");
		const path = process.argv[3]!;
		const installed = existsSync(path) ? readFileSync(path, "utf8") : null;
		const out = carryDeployConfig(readFileSync(0, "utf8"), installed);
		process.stderr.write(`deploy: ${installed === null ? "fresh profile; template targets used" : "installed declarations carried; newest policy acceptance unchanged"}\n`);
		process.stdout.write(out);
	} catch (err) {
		process.stderr.write(`deploy: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	}
}
