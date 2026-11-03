#!/usr/bin/env bun
// routing-report: the read-only routing report for Jo's terminal (PLAN wl-mv71x5rwdu7eo0 rev 4 § 2.1).
//
//   bun surface/scripts/routing-report.ts [--since <ISO>] [--until <ISO>] [--split <ISO>] [--workload <wl>]
//                                         [--ledger <path>] [--json]          (as2 routing [args])
//
// Reads the `routings` rows and the `headroom-skip:` entries in the window through the ledger module, opened
// `{ readonly: true }` (the ledger is `--ledger`, else the one the surface opens: $AGENT_SYSTEM_LEDGER_DB, else
// $HOME/.agent-system-2/ledger.db), and each hand's session file; writes nothing. `--since` is inclusive, `--until`
// exclusive; `--split` prints the rows before it and at or after it as two cohorts. Text by default, the report object
// with `--json`. The first line is the header, `<N> rows · jev <J> · change-large <L> of <C> code rows`.
// Exit 0 with the report; 1 when the ledger could not be read or a session file was unreadable (the report is still
// printed, the unreadable files listed); 2 on a bad argument, naming it.
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { HEADROOM_SKIP_PREFIX, readHandUsage, renderRoutingReport, type RoutingReport, routingReport } from "../src/routing-report";

const USAGE = "usage: bun surface/scripts/routing-report.ts [--since <ISO>] [--until <ISO>] [--split <ISO>] [--workload <wl-id>] [--ledger <path>] [--json]";

/** An ISO date or UTC/offset instant, as the column's form (`…T…:…:….sssZ`); null when it is not one. */
function instant(text: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

interface Args {
	since?: string;
	until?: string;
	split?: string;
	workload?: string;
	ledger?: string;
	json: boolean;
}

/** The parsed arguments, or the message naming the bad one. */
export function parseArgs(argv: readonly string[]): Args | { error: string } {
	const out: Args = { json: false };
	const seen = new Set<string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (seen.has(arg)) return { error: `${arg} given twice` };
		seen.add(arg);
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (!["--since", "--until", "--split", "--workload", "--ledger"].includes(arg)) return { error: `unknown argument ${JSON.stringify(arg)}` };
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
		if (arg === "--workload") {
			if (!/^wl-\S+$/.test(value)) return { error: `--workload ${JSON.stringify(value)} is not a workload id (wl-…)` };
			out.workload = value;
		} else if (arg === "--ledger") {
			if (value.trim() === "") return { error: "--ledger needs a path" };
			out.ledger = value;
		} else {
			const at = instant(value);
			if (at === null) return { error: `${arg} ${JSON.stringify(value)} is not an ISO date or instant (e.g. 2026-10-13T19:04:00Z)` };
			out[arg.slice(2) as "since" | "until" | "split"] = at;
		}
	}
	if (out.since !== undefined && out.until !== undefined && out.since >= out.until) return { error: `--since ${out.since} is not before --until ${out.until}` };
	return out;
}

function main(argv: string[]): number {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(USAGE);
		return 0;
	}
	const args = parseArgs(argv);
	if ("error" in args) {
		console.error(`as2 routing: ${args.error}\n${USAGE}`);
		return 2;
	}
	let path = args.ledger;
	let ledger: Ledger;
	try {
		path ??= defaultLedgerPath(process.env);
		ledger = Ledger.open(path, { readonly: true });
	} catch (err) {
		console.error(`as2 routing: could not open the ledger${path ? ` at ${path}` : ""} (${err instanceof Error ? err.message : String(err)})`);
		return 1;
	}
	let report: RoutingReport;
	try {
		const range = { since: args.since, until: args.until, workloadId: args.workload };
		report = routingReport(ledger.routingsIn(range), {
			usage: readHandUsage,
			entries: ledger.entriesWithPrefix(HEADROOM_SKIP_PREFIX, range),
			split: args.split ?? null,
			range: { since: args.since, until: args.until, workload: args.workload },
		});
	} catch (err) {
		console.error(`as2 routing: could not build the report from ${path} (${err instanceof Error ? err.message : String(err)})`);
		return 1;
	} finally {
		ledger.close();
	}
	console.log(args.json ? JSON.stringify(report, null, 2) : renderRoutingReport(report));
	const unreadable = report.hands.filter((h) => h.state === "unreadable");
	if (unreadable.length > 0) {
		console.error(`as2 routing: ${unreadable.length} session file(s) could not be read; their cost is n/a (listed in the report): ${unreadable.map((h) => `${h.file} (${h.error})`).join("; ")}`);
		return 1;
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
