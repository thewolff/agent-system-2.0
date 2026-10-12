// The off-disk copy (audit finding A1-3): every scheduled copy sits in `backups/` beside the ledger,
// on the ledger's own disk, so one disk failure takes the ledger and every copy with it. When a
// destination is configured, the backup job also mirrors the newest complete copy there.
//
// Configuration is one file beside the ledger, `backup-offdisk-dir`, holding one absolute path (a
// directory on another disk: an external drive, a second internal disk). Absent file = none
// configured; nothing here invents a destination. The file, not an environment variable, so the
// launchd job and the invariant report read the same answer whatever their environments.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { BACKUP_NAME, BACKUP_SOURCE_FILE, backupNamespace, copyProblem, type Ledger, processAlive } from "./index";

export const OFFDISK_CONFIG_FILE = "backup-offdisk-dir";
/** A copy's temporary file in the off-disk namespace: `.<copy name>.<writer pid>-<random>.tmp`. */
const OFFDISK_TEMP_NAME = /^\.ledger-[^/]*\.db\.(\d+)-[0-9a-z]*\.tmp$/;

/** The off-disk configuration for the ledger at canonical path `ledgerPath`. */
export interface OffDiskConfig {
	/** The config file's path: `<ledger dir>/backup-offdisk-dir`. */
	config: string;
	/** The configured destination root, or null when the config file is absent. */
	dir: string | null;
}

/** Read the config. Throws when the file exists but does not hold one absolute path. */
export function readOffDiskConfig(ledgerPath: string): OffDiskConfig {
	const config = join(dirname(ledgerPath), OFFDISK_CONFIG_FILE);
	if (!existsSync(config)) return { config, dir: null };
	const lines = readFileSync(config, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length !== 1 || !isAbsolute(lines[0]!)) {
		throw new Error(`off-disk config ${config} must hold exactly one absolute directory path, found ${JSON.stringify(lines)}`);
	}
	return { config, dir: lines[0]! };
}

/** This ledger's namespace directory under an off-disk root (the same name as under `backups/`). */
export function offDiskNamespace(root: string, ledgerPath: string): string {
	return join(root, backupNamespace(ledgerPath));
}

/**
 * Mirror the ledger's newest complete local copy into `<root>/<namespace>/` under the same name,
 * then keep the newest `keep` there. The root must already exist (an unmounted drive is an error,
 * never a directory created on the ledger's disk) and must be on another device than the ledger.
 * The copy goes through a temporary dot-file, is checked with `copyProblem`, and only then linked
 * to its name, so a name there is always a complete copy. Returns the copy written, or null when
 * the newest local copy is already there. `deviceOf` (default: `statSync(path).dev`) is the one
 * test seam: a test runner has one disk, so a test stands in a second device id for the root and
 * keeps every file operation real.
 */
export function syncOffDisk(
	ledger: Ledger,
	root: string,
	keep: number,
	deviceOf: (path: string) => number | bigint = (path) => statSync(path).dev,
): { copied: string | null; newest: string } {
	let rootStat;
	try {
		rootStat = statSync(root);
	} catch {
		throw new Error(`off-disk destination ${root} does not exist (not mounted?); it is never created here`);
	}
	if (!rootStat.isDirectory()) throw new Error(`off-disk destination ${root} is not a directory`);
	if (deviceOf(root) === deviceOf(dirname(ledger.path))) {
		throw new Error(`off-disk destination ${root} is on the same disk as the ledger ${ledger.path}; it protects nothing there`);
	}
	const local = ledger.backups().reverse().find((c) => copyProblem(c.path) === null);
	if (!local) throw new Error(`no complete local copy in ${ledger.backupDir} to mirror`);
	const dir = offDiskNamespace(root, ledger.path);
	mkdirSync(dir, { recursive: true });
	const source = join(dir, BACKUP_SOURCE_FILE);
	if (existsSync(source)) {
		const owner = readFileSync(source, "utf8").trim();
		if (owner !== ledger.path) throw new Error(`off-disk directory ${dir} holds copies of ${owner}, not of ${ledger.path}`);
	} else writeFileSync(source, `${ledger.path}\n`);

	const dest = join(dir, basename(local.path));
	let copied: string | null = null;
	if (!(existsSync(dest) && copyProblem(dest) === null)) {
		if (existsSync(dest)) throw new Error(`off-disk ${dest} exists and is not a complete copy (${copyProblem(dest)}); set it aside by hand`);
		const tmp = join(dir, `.${basename(dest)}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
		try {
			copyFileSync(local.path, tmp);
			const problem = copyProblem(tmp);
			if (problem) throw new Error(`off-disk copy of ${local.path} is not a complete copy (${problem})`);
			linkSync(tmp, dest); // never replaces a copy
		} finally {
			rmSync(tmp, { force: true });
		}
		copied = dest;
	}
	const names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n)).sort();
	for (const old of names.slice(0, Math.max(0, names.length - Math.max(1, keep)))) rmSync(join(dir, old), { force: true });
	for (const name of readdirSync(dir)) {
		const m = OFFDISK_TEMP_NAME.exec(name);
		if (m && !processAlive(Number(m[1]))) rmSync(join(dir, name), { force: true });
	}
	return { copied, newest: dest };
}
