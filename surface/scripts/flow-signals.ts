#!/usr/bin/env bun
// flow-signals: the fallback writer of the noon `flow-signals:` line (PLAN wl-mv654hoqwpfhmo § 3a), run by launchd every
// 30 min (install/com.agent-system-2.flow-signals.plist, StartInterval 1800, written by install.sh --flow-signals).
//
//   bun surface/scripts/flow-signals.ts [--dry-run [--cap <n>]]
//
// The orchestrator's invariant timer writes the line at its first tick at or after 12:00 America/Los_Angeles
// (surface/extensions/wake.ts). When the orchestrator is down this job writes the same line, with `source fallback`,
// on its first run past 12:30 Pacific on a date with no `flow-signals:` entry; otherwise it writes nothing. The check and
// the insert run in one write transaction (surface/src/flow.ts writeFlowSignals), so this job and the timer racing on a
// date write one line.
//
// The lane cap is the orchestrator's, not this job's: launchd's env does not carry AGENT_SYSTEM_MAX_LANES. So the cap and
// its `cap-source` are copied from the newest `flow-signals:` entry; with none, `laneCap(process.env)` with `cap-source
// default`.
//
// --dry-run prints the line it would write for now (whatever the time, entry or not) and writes nothing; `--cap <n>`
// (only with --dry-run) judges against that cap instead, with `cap-source flag`, a source no written line carries. The
// ledger is $AGENT_SYSTEM_LEDGER_DB, else $HOME/.agent-system-2/ledger.db. The clock is $AS2_NOW (an ISO-8601 instant)
// when set, else the real one.
// Exit: 0 written, skipped or printed (one line on stdout says which), 1 the ledger could not be read or written,
// 2 bad arguments or a bad AS2_NOW.
import { Database } from "bun:sqlite";
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { type CapSource, FALLBACK_AFTER_S, flowEntries, flowLine, type FlowSignals, flowSignals, lineDate, pacificSeconds, recordedCap, writeFlowSignals } from "../src/flow";
import { laneCap } from "../src/launch";
import { STANDING_WORKLOAD_ID } from "../src/types";

export const NOW_ENV = "AS2_NOW";

interface Args {
	dryRun: boolean;
	cap: number | null;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { dryRun: false, cap: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--dry-run") args.dryRun = true;
		else if (a === "--cap") {
			const n = Number(argv[++i]);
			if (!Number.isInteger(n) || n <= 0) throw new Error("--cap takes a positive whole number of lanes");
			args.cap = n;
		} else throw new Error(`unknown argument ${a}`);
	}
	if (args.cap !== null && !args.dryRun) throw new Error("--cap is for --dry-run only: a written line carries the orchestrator's cap");
	return args;
}

/** The as-of instant: $AS2_NOW when set (normalised to ISO), else the real clock. */
function asOfFrom(env: Record<string, string | undefined>): string {
	const raw = env[NOW_ENV];
	if (raw === undefined || raw.trim() === "") return new Date().toISOString();
	const t = Date.parse(raw);
	if (Number.isNaN(t)) throw new Error(`${NOW_ENV} is not an ISO-8601 instant: ${raw}`);
	return new Date(t).toISOString();
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
	let args: Args;
	let asOf: string;
	try {
		args = parseArgs(argv);
		asOf = asOfFrom(env);
	} catch (err) {
		console.error(`flow-signals: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	try {
		const path = defaultLedgerPath(env);
		const ledger = Ledger.open(path, { backupOnOpen: false, ...(env[NOW_ENV] ? { clock: () => asOf } : {}), ...(args.dryRun ? { readonly: true } : {}) });
		try {
			const prior = flowEntries(ledger.entries(STANDING_WORKLOAD_ID, "assumption"));
			const recorded = recordedCap(prior);
			const own: { cap: number; capSource: CapSource } = recorded ? { cap: recorded.cap, capSource: recorded.source } : { cap: laneCap(env), capSource: "default" };
			const cap = args.cap ?? own.cap;
			const db = new Database(path, { readonly: true });
			let f: FlowSignals;
			try {
				f = flowSignals(db, asOf, cap);
			} finally {
				db.close();
			}
			if (args.dryRun) {
				console.log(flowLine(f, { capSource: args.cap !== null ? "flag" : own.capSource, source: "fallback", prior }));
				return 0;
			}
			if (pacificSeconds(asOf) <= FALLBACK_AFTER_S) {
				console.log(`flow-signals: not past 12:30 Pacific (${f.date}); nothing written`);
				return 0;
			}
			if (prior.some((e) => lineDate(e.body) === f.date)) {
				console.log(`flow-signals: ${f.date} already has a line; nothing written`);
				return 0;
			}
			const { entry, body } = writeFlowSignals(ledger, f, { capSource: own.capSource, source: "fallback" });
			console.log(entry ? `${body} (entry ${entry})` : `flow-signals: ${f.date} already has a line; nothing written`);
			return 0;
		} finally {
			ledger.close();
		}
	} catch (err) {
		console.error(`flow-signals: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
