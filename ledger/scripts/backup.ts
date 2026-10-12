// The scheduled second copy (SPEC-2.0.md § B2 prior art e): the backup job.
// Usage: bun run ledger/scripts/backup.ts [path] [--force]
// The periodic launchd agent the installer writes (install/com.agent-system-2.ledger-backup.plist)
// runs this hourly with AGENT_SYSTEM_LEDGER_DB set; the installer also runs it once so a fresh
// machine starts with a copy. When this ledger's newest copy is at least 55 minutes old (or there
// is none) it takes a VACUUM INTO copy into the ledger's own namespace under `backups/` beside it,
// then keeps that ledger's newest 48 (BACKUP_DEFAULTS); --force takes one regardless. Opening a
// ledger also takes a due copy, as a fallback that only reports a failure; this job is strict: a
// due copy that fails is exit 1, even when an older copy exists.
// Off-disk (ledger/src/offdisk.ts): when `backup-offdisk-dir` beside the ledger names a
// destination, the newest complete copy is mirrored there (same name, newest 48 kept); a missing,
// unmounted or same-disk destination is exit 1. With no such file it says none is configured.
// Prints two lines: the copy taken (or the newest copy when none was due), then the off-disk result.
// Exit: 0 ok · 1 failure (including a due copy or off-disk mirror that could not be taken) · 3 path
// refused as synced or network · 4 the file is not at the supported schema version (refused unchanged).
import { BACKUP_DEFAULTS, defaultLedgerPath, Ledger, LedgerLocationError, LedgerSchemaVersionError } from "../src/index";
import { readOffDiskConfig, syncOffDisk } from "../src/offdisk";

const args = process.argv.slice(2);
const force = args.includes("--force");
const path = args.find((a) => a !== "--force") ?? defaultLedgerPath();
try {
	const ledger = Ledger.open(path, { backupOnOpen: false });
	try {
		const taken = ledger.backupIfDue(force);
		const newest = ledger.backups().at(-1);
		if (!newest) throw new Error(`no copy was taken and none exists in ${ledger.backupDir}`);
		console.log(taken ? `backup ok: took ${taken}` : `backup ok: none due; newest ${newest.path}`);
		const offDisk = readOffDiskConfig(ledger.path);
		if (offDisk.dir === null) console.log(`off-disk: none configured (${offDisk.config} absent); every copy is on the ledger's disk`);
		else {
			const r = syncOffDisk(ledger, offDisk.dir, BACKUP_DEFAULTS.keep);
			console.log(r.copied ? `off-disk ok: copied ${r.copied}` : `off-disk ok: up to date; newest ${r.newest}`);
		}
	} finally {
		ledger.close();
	}
} catch (e) {
	console.error(`ledger backup failed: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(e instanceof LedgerLocationError ? 3 : e instanceof LedgerSchemaVersionError ? 4 : 1);
}
