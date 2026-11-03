#!/usr/bin/env bun
// rank: Jev ranking's read-only view for Jo's terminal and anything outside OMP (PLAN wl-mv8k039gvogt8g § 2 D5).
//
//   bun surface/scripts/rank.ts [--top N]        (as2 rank [--top N])
//
// The same table `as2_rank` returns (surface/extensions/rank.ts `rankTable` over `rankOpen`), minus the fill: nothing is
// asked, so a workload with no current signal is listed unscored with its reason. The ledger is the one the surface
// opens ($AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db), opened `{ readonly: true }`; nothing is written
// anywhere. Exit 0 with the table, 1 on a bad argument, 2 when it could not run (no ledger to open).
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { RANK_TOP, rankTable } from "../extensions/rank";
import { rankOpen } from "../src/rank";
import { readRankConfig } from "../src/rank-launch";

const USAGE = "usage: bun surface/scripts/rank.ts [--top N]";

function main(argv: string[]): number {
	let top = RANK_TOP;
	for (let i = 0; i < argv.length; i++) {
		const n = argv[i] === "--top" ? Number(argv[++i]) : Number.NaN;
		if (!Number.isInteger(n) || n <= 0) {
			console.error(USAGE);
			return 1;
		}
		top = n;
	}
	const path = defaultLedgerPath(process.env);
	let ledger: Ledger;
	try {
		ledger = Ledger.open(path, { readonly: true });
	} catch (err) {
		console.error(`as2 rank: could not open the ledger (${err instanceof Error ? err.message : String(err)})`);
		return 2;
	}
	try {
		const now = new Date().toISOString();
		const heading = `Jev rank (as2 rank, read-only, ${now})`;
		console.log(rankTable(ledger, now, rankOpen(ledger, now), { top, heading, fill: "fill: none (read-only: Jev is not asked here; as2_rank asks)", config: readRankConfig(process.env) }));
	} finally {
		ledger.close();
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
