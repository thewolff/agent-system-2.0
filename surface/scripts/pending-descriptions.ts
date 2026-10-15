// pending-descriptions: the read-only side of the pending-description backfill (PLAN
// wl-mv7gidggnlkem8 § Backfill and deployment). It never writes the ledger: applying a reviewed
// manifest is the orchestrator's `orchestrator_describe_pending` tool alone
// (surface/extensions/pending-descriptions.ts), and this script shares that tool's manifest reader and
// coverage reader, so what it checks is what the tool applies.
//
//   bun surface/scripts/pending-descriptions.ts snapshot
//   bun surface/scripts/pending-descriptions.ts export
//   bun surface/scripts/pending-descriptions.ts check [--manifest <absolute path> --sha256 <hex>]
//
// snapshot: JSON of everything pending shows (open workloads and closed question subjects with their
// brief, done line and source hash; open questions with body, options, subject, the ask pending shows
// now and source hash; waiting reserved requests; prompt waits) and each one's current name/ask or gap:
// what the author reads before writing names and asks.
// export: the manifest skeleton for exactly the gaps pending's own rows report, values empty for the
// author to fill (`name` only on an unbound orchestrator question). A machine question whose fixed
// phrase map covers its options is not a gap; one with an unsupported option is.
// check: a JSON report. `missing` lists the current gaps a manifest fills; `unfillable` the closed
// workloads an open orchestrator question still names with no name (answer or withdraw the question).
// With a manifest (its exact bytes must hash to --sha256) also `manifest`: per entry equal / differ /
// unapplied / stale / closed, and `unsubmitted`, the gaps it does not list. `ok` is true only with zero
// gaps of either kind and, with a manifest, every live entry stored exactly as reviewed.
//
// The ledger is $AGENT_SYSTEM_LEDGER_DB, else ~/.agent-system-2/ledger.db (refused under test when
// live), opened through Ledger.open with { readonly: true }: no pragma, schema init, WAL or backup
// write. There is no path argument.
// Exit: 0 printed (check: ok) · 1 check not ok · 2 usage, no ledger, or a refused manifest.
import { defaultLedgerPath, Ledger } from "../../ledger/src/index";
import { checkManifest, exportSkeleton, pendingCoverage, readReviewedManifest } from "../extensions/pending-descriptions";

export const USAGE = "usage: bun surface/scripts/pending-descriptions.ts snapshot | export | check [--manifest <absolute path> --sha256 <hex>]";

/** Run one command against the ledger `env` names; output goes to `out`/`err`, the exit code is returned. */
export function main(argv: readonly string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = (s) => process.stdout.write(s), err: (s: string) => void = (s) => process.stderr.write(s)): number {
	const [cmd, ...rest] = argv;
	let manifestPath: string | null = null;
	let sha256: string | null = null;
	if (cmd === "check") {
		for (let i = 0; i < rest.length; i += 2) {
			const flag = rest[i];
			const value = rest[i + 1];
			if (value === undefined || (flag !== "--manifest" && flag !== "--sha256")) {
				err(`${USAGE}\n`);
				return 2;
			}
			if (flag === "--manifest") manifestPath = value;
			else sha256 = value;
		}
		if ((manifestPath === null) !== (sha256 === null)) {
			err(`check takes --manifest and --sha256 together\n${USAGE}\n`);
			return 2;
		}
	} else if ((cmd !== "snapshot" && cmd !== "export") || rest.length > 0) {
		err(`${USAGE}\n`);
		return 2;
	}
	const manifest = manifestPath !== null && sha256 !== null ? readReviewedManifest(manifestPath, sha256) : null;
	if (manifest !== null && "refused" in manifest) {
		err(`pending-descriptions: refused: ${manifest.refused}\n`);
		return 2;
	}
	let ledger: Ledger;
	try {
		ledger = Ledger.open(defaultLedgerPath(env), { readonly: true });
	} catch (e) {
		err(`pending-descriptions: the ledger could not be opened read-only: ${e instanceof Error ? e.message : String(e)}\n`);
		return 2;
	}
	try {
		const coverage = pendingCoverage(ledger);
		if (cmd === "snapshot") {
			out(`${JSON.stringify({ ledger: ledger.path, ...coverage }, null, 2)}\n`);
			return 0;
		}
		if (cmd === "export") {
			out(`${JSON.stringify(exportSkeleton(coverage), null, 2)}\n`);
			return 0;
		}
		const report = manifest === null ? null : checkManifest(ledger, manifest.manifest, manifest.sha256, coverage);
		const ok = coverage.missing.length === 0 && coverage.unfillable.length === 0 && (report === null || (report.differ.length === 0 && report.unapplied.length === 0 && report.stale.length === 0));
		out(`${JSON.stringify({ ledger: ledger.path, ok, missing: coverage.missing, unfillable: coverage.unfillable, ...(report === null ? {} : { manifest: report }) }, null, 2)}\n`);
		return ok ? 0 : 1;
	} finally {
		ledger.close();
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
