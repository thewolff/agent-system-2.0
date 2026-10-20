// Upgrade a ledger to the module's schema version: the only path that does (Ledger.open never upgrades).
// Usage: bun run ledger/scripts/migrate.ts [path] [--dry-run] [--force]
// Path: $AGENT_SYSTEM_LEDGER_DB or the default path when omitted. Refuses a synced or network folder.
// Order: every check before the snapshot reads the file through a connection that writes nothing. A
// file already at the current version is checked and left untouched (idempotent). Otherwise it is
// refused unchanged when its triggers are not its version's or a lane holds a workload under a live
// lease (--force overrides the lease check only). Then the preview is printed: the version from and
// to, the triggers the upgrade adds, the live leases, the snapshot it would write and the undo.
// --dry-run stops there, having written nothing. Otherwise the run reads one line from stdin and
// goes on only if it is exactly MIGRATE (MIGRATION.md item 114: a preview and a typed confirmation
// before it writes); then a `VACUUM INTO` snapshot is written beside the file and checked; then the
// snapshot path and the undo are printed; then the upgrade runs in one transaction, which checks the
// version and (without --force) the leases again under its write lock.
// Exit: 0 upgraded, already current, or a dry run whose checks passed · 1 other failure · 2 unknown
// argument · 3 path refused · 4 a schema version the module neither supports nor upgrades, or one that
// changed under the lock · 5 the file's trigger set is not its version's · 6 held by a live lane ·
// 7 the confirmation was not typed. A non-zero exit before the snapshot line wrote nothing at all.
// After it, the snapshot is kept and the last line reads the schema version back, so whether the
// upgrade committed is shown, not assumed.
import {
	defaultLedgerPath, LedgerHeldError, LedgerLocationError, LedgerSchemaVersionError, LedgerTriggerDriftError, migrateLedger,
	planMigration, schemaVersionOf, snapshotPath,
} from "../src/index";

/** The word a real run waits for on stdin before it writes anything. */
const CONFIRM_WORD = "MIGRATE";

/** One POSIX shell word: single-quoted, so zsh and sh expand nothing in it. */
const shellWord = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const FLAGS = ["--dry-run", "--force"];
const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith("--") && !FLAGS.includes(a));
if (unknown.length) {
	console.error(`ledger migrate: unknown argument ${unknown.join(" ")}; usage: migrate.ts [path] [--dry-run] [--force]`);
	process.exit(2);
}
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const path = args.find((a) => !FLAGS.includes(a)) ?? defaultLedgerPath();

/** The first line of stdin, or null at end of input. */
async function readLine(): Promise<string | null> {
	for await (const line of console) return line;
	return null;
}

/** Set once the recovery lines are printed: from then on a failure reads the version back. */
const run: { begun: { path: string; from: number } | null } = { begun: null };
try {
	const plan = planMigration(path, { force });
	if (plan.undo === null) {
		console.log(`ledger ok: path=${plan.path} schema_version=${plan.to} (already current; nothing written)`);
		process.exit(0);
	}
	const adds = plan.steps.flatMap((s) => s.addsTriggers);
	console.log(`${dryRun ? "dry run" : "preview"}: ledger ${plan.path}`);
	console.log(`  schema version: ${plan.from} -> ${plan.to}`);
	console.log(`  adds ${adds.length} trigger(s), no column and no table: ${adds.join(", ")}`);
	console.log("  rows: none written, none rewritten");
	console.log(plan.held.length
		? `  live leases: ${plan.held.length}, overridden by --force (${plan.held.map((h) => `${h.id} by ${h.holder}`).join(", ")})`
		: "  live leases: none");
	console.log(`  writes first: a VACUUM INTO snapshot beside the file, named like ${snapshotPath(plan.path, new Date())}`);
	console.log(`  undo after the upgrade: sqlite3 ${shellWord(plan.path)} ${shellWord(plan.undo)}`);
	if (dryRun) {
		console.log("dry run: nothing written");
		process.exit(0);
	}
	process.stdout.write(`Type ${CONFIRM_WORD} to upgrade ${plan.path} from version ${plan.from} to ${plan.to}; anything else stops with nothing written: `);
	const typed = await readLine();
	// Piped input is not echoed: end the prompt's line so the next line starts at column 0.
	console.log("");
	if (typed?.trim() !== CONFIRM_WORD) {
		console.error(`ledger migrate refused: ${typed === null ? "no confirmation (end of input)" : `typed ${JSON.stringify(typed)}, not ${CONFIRM_WORD}`}; nothing written`);
		process.exit(7);
	}
	const t0 = performance.now();
	const r = migrateLedger(path, {
		force,
		beforeUpgrade: (recovery) => {
			run.begun = recovery;
			if (recovery.snapshot) console.log(`snapshot (version ${recovery.from}, taken before any write): ${recovery.snapshot}`);
			console.log(`undo, lossless (keeps every row written since): sqlite3 ${shellWord(recovery.path)} ${shellWord(recovery.undo)}`);
		},
	});
	if (r.from === r.to) {
		console.log(`ledger ok: path=${r.path} schema_version=${r.to} (already current; nothing written)`);
	} else {
		console.log(`ledger migrated: path=${r.path} from=${r.from} to=${r.to} in ${(performance.now() - t0).toFixed(1)} ms`);
	}
} catch (e) {
	console.error(`ledger migrate failed: ${e instanceof Error ? e.message : String(e)}`);
	const begun = run.begun;
	if (begun) {
		let now: string;
		try {
			const v = schemaVersionOf(begun.path);
			now = v === begun.from ? `${v}: the upgrade did not commit` : `${v}: NOT the version checked (${begun.from}); inspect the file before anything else`;
		} catch (r) {
			now = `unreadable (${r instanceof Error ? r.message : String(r)})`;
		}
		console.error(`schema version read back now: ${now}; the snapshot printed above is kept`);
	}
	process.exit(e instanceof LedgerLocationError ? 3 : e instanceof LedgerSchemaVersionError ? 4 : e instanceof LedgerTriggerDriftError ? 5
		: e instanceof LedgerHeldError ? 6 : 1);
}
