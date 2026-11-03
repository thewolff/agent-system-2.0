#!/usr/bin/env bun
// `as2 rank-mode show|order|parallel [--budget <usd>]` (PLAN wl-mv8k039gvogt8g § 2 D7): set the `jevRank` block in the
// installed profile's config.yml (`installedConfigPath`, where `pairSuggest` lives and `readRankConfig` reads it fresh at
// every launch decision). `--budget` sets `parallelBudgetUsd`; without it the budget in force is kept. Prints
// `jevRank: <old> -> <new> (<path>)`. An unknown mode, a malformed budget, a missing config, or an edit that would
// change any other setting exits 1 and writes nothing. `show` is the reversal. Never starts omp.
//
// The edit is a text edit: the top-level `jevRank:` line and the indented lines under it are replaced by the new block
// (appended when absent), written to a temp file and renamed into place only after bun's YAML reads it back with
// `jevRank` as intended and every other key as before.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { installedConfigPath } from "../src/pair-suggest";
import { JEV_RANK_KEY, parseRankConfig, type RankConfig, RANK_MODES, type RankMode } from "../src/rank-launch";

const USAGE = `usage: as2 rank-mode ${RANK_MODES.join("|")} [--budget <usd>]`;

/** The config text with its `jevRank` block replaced by `next` (appended when it has none). */
export function withRankBlock(text: string, next: RankConfig): string {
	const block = [`${JEV_RANK_KEY}:`, `  mode: ${next.mode}`, `  parallelBudgetUsd: ${next.parallelBudgetUsd}`];
	const lines = text.split("\n");
	const start = lines.findIndex((l) => new RegExp(`^${JEV_RANK_KEY}:`).test(l));
	if (start === -1) {
		const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
		return `${body}${block.join("\n")}\n`;
	}
	let end = start + 1;
	while (end < lines.length && /^[ \t]+\S/.test(lines[end]!)) end++;
	return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
}

const describe = (c: RankConfig): string => `mode ${c.mode} parallelBudgetUsd ${c.parallelBudgetUsd}`;
const fail = (message: string): number => {
	process.stderr.write(`as2 rank-mode: ${message}\n`);
	return 1;
};

export function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): number {
	const [mode, ...rest] = argv;
	if (mode === undefined || !(RANK_MODES as readonly string[]).includes(mode)) return fail(`${mode === undefined ? "a mode is required" : `unknown mode "${mode}"`}; nothing was written. ${USAGE}`);
	let budget: number | null = null;
	if (rest.length > 0) {
		const value = rest[0] === "--budget" && rest.length === 2 ? Number(rest[1]) : Number.NaN;
		if (!Number.isFinite(value) || value < 0 || rest[1]!.trim() === "") return fail(`"${rest.join(" ")}" is not --budget <usd> (a number, 0 or more); nothing was written. ${USAGE}`);
		budget = value;
	}
	const path = installedConfigPath(env);
	if (!existsSync(path)) return fail(`no installed profile config at ${path}; run: as2 install`);
	const text = readFileSync(path, "utf8");
	let before: Record<string, unknown>;
	try {
		before = (Bun.YAML.parse(text) ?? {}) as Record<string, unknown>;
	} catch (err) {
		return fail(`${path} does not parse (${String(err)}); nothing was written`);
	}
	const old = parseRankConfig(before);
	const next: RankConfig = { mode: mode as RankMode, parallelBudgetUsd: budget ?? old.parallelBudgetUsd };
	const edited = withRankBlock(text, next);
	let after: Record<string, unknown>;
	try {
		after = (Bun.YAML.parse(edited) ?? {}) as Record<string, unknown>;
	} catch (err) {
		return fail(`the edit would not parse (${String(err)}); ${path} is unchanged; set ${JEV_RANK_KEY} by hand`);
	}
	const { [JEV_RANK_KEY]: _was, ...otherBefore } = before;
	const { [JEV_RANK_KEY]: _now, ...otherAfter } = after;
	if (!Bun.deepEquals(after[JEV_RANK_KEY], { mode: next.mode, parallelBudgetUsd: next.parallelBudgetUsd }) || !Bun.deepEquals(otherAfter, otherBefore)) {
		return fail(`the edit would change more than ${JEV_RANK_KEY}; ${path} is unchanged; set ${JEV_RANK_KEY} by hand (a block mapping at the top level is what this command edits)`);
	}
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, edited);
	renameSync(tmp, path);
	process.stdout.write(`${JEV_RANK_KEY}: ${describe(old)} -> ${describe(next)} (${path})\n`);
	if (next.mode === "parallel" && next.parallelBudgetUsd === 0) process.stdout.write("parallelBudgetUsd is 0: the budget is unknown, so no lane starts beside another; set it with --budget <usd>\n");
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
