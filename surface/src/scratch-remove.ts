// The one removal every scratch cleanup goes through (PLAN wl-mv5oikd5jtquww § 1.5–1.7): the close's
// archiveScratchRoot (surface/src/close-entry.ts), the daily sweep (surface/scripts/scratch-sweep.ts) and the audit's
// `delete` of a quarantine stamp (surface/scripts/scratch-audit.ts). A path checked and then removed by name can be
// redirected between the two: a same-user process renames an ancestor away and puts a symlink in its place, and the
// recursive remove lands in another directory's child of the same name. So a child is removed only through
//   (a) a check that it is still the real directory judged (same dev/ino, not a symlink) under a parent whose realpath
//       is the parent passed,
//   (b) an atomic rename to `<parent>/.removing-<name>-<random hex>` in the same directory,
//   (c) a check that the renamed entry is still the judged directory (an ancestor swapped between (a) and (b) moved
//       some other directory: it is renamed back when nothing took its old name, and the removal is refused),
//   (d) a recursive remove of the renamed path (links inside are removed as links, never followed).
// detachChild is (a)–(c) and purgeDetached is (d), so a caller can take (a)–(c) under a lock and run the slow (d) after
// releasing it (the daily sweep, under the ledger's write lock); removeChild is both, for the close and the audit's delete.
// Residual risk: after (c) the remove still goes by pathname, so a second swap would have to recreate the random
// `.removing-*` name somewhere else to redirect it; a same-user process able to do that can already delete those
// files itself. A remove that fails part-way leaves the `.removing-*` entry; the sweep removes it once idle.
import { randomBytes } from "node:crypto";
import { type BigIntStats, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The name prefix of a child being removed (step (b)); the sweep removes one left behind once it has been idle. */
export const REMOVING_PREFIX = ".removing-";

/** What a directory was when it was judged removable: its device and inode, exact (bigint lstat). */
export interface Identity {
	dev: bigint;
	ino: bigint;
}

/** `path`'s own identity (lstat: a link is not followed). Throws when it cannot be read. */
export function fileIdentity(path: string): Identity {
	const st = lstatSync(path, { bigint: true });
	return { dev: st.dev, ino: st.ino };
}

export type Removal =
	| { kind: "removed"; path: string }
	| { kind: "refused"; path: string; reason: string }
	| { kind: "failed"; path: string; error: string };

/** Steps (a)–(c) done: the judged directory `path` now sits at `doomed`, nothing removed yet. */
export interface Detached {
	kind: "detached";
	path: string;
	doomed: string;
}

export type Detach = Detached | Exclude<Removal, { kind: "removed" }>;

/** Test seam: `beforeRename` runs between the check (a) and the rename (b). */
export interface RemoveHooks {
	beforeRename?: () => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Steps (a)–(c): rename the directory `name` under the physical directory `parent` to `<parent>/.removing-<name>-<hex>`,
 * only when it is still the directory judged (`judged`, its identity when the caller decided to remove it), and check
 * that the rename moved that directory. Removes nothing. Never throws.
 */
export function detachChild(parent: string, name: string, judged: Identity, hooks: RemoveHooks = {}): Detach {
	const child = join(parent, name);
	if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
		return { kind: "refused", path: child, reason: `${JSON.stringify(name)} is not a child name` };
	}
	let st: BigIntStats;
	try {
		const real = realpathSync.native(parent);
		if (real !== parent) return { kind: "refused", path: child, reason: `${parent} resolves to ${real}: not the physical parent` };
		st = lstatSync(child, { bigint: true });
	} catch (e) {
		return { kind: "refused", path: child, reason: `${child} cannot be checked: ${message(e)}` };
	}
	if (st.isSymbolicLink()) return { kind: "refused", path: child, reason: `${child} is a symlink` };
	if (!st.isDirectory()) return { kind: "refused", path: child, reason: `${child} is not a directory` };
	if (st.dev !== judged.dev || st.ino !== judged.ino) return { kind: "refused", path: child, reason: `${child} is not the directory that was judged (its dev/ino changed)` };

	hooks.beforeRename?.();
	const doomed = join(parent, `${REMOVING_PREFIX}${name}-${randomBytes(8).toString("hex")}`);
	try {
		renameSync(child, doomed);
	} catch (e) {
		return { kind: "failed", path: child, error: `rename to ${doomed}: ${message(e)}` };
	}
	let moved: BigIntStats;
	try {
		moved = lstatSync(doomed, { bigint: true });
	} catch (e) {
		return { kind: "refused", path: child, reason: `the renamed ${doomed} cannot be checked (${message(e)}); nothing removed` };
	}
	if (moved.isSymbolicLink() || !moved.isDirectory() || moved.dev !== judged.dev || moved.ino !== judged.ino) {
		return { kind: "refused", path: child, reason: `the rename reached a directory that is not the one judged (an ancestor of ${child} was swapped); ${putBack(doomed, child).said}; nothing removed` };
	}
	return { kind: "detached", path: child, doomed };
}

/** Step (d): the recursive remove of what detachChild renamed aside (links inside are removed as links). Never throws. */
export function purgeDetached(d: Detached): Removal {
	try {
		rmSync(d.doomed, { recursive: true });
	} catch (e) {
		return { kind: "failed", path: d.path, error: `removing ${d.doomed}: ${message(e)}` };
	}
	return { kind: "removed", path: d.path };
}

/** detachChild then purgeDetached: remove `name` under `parent` only when it is still the directory judged. Never throws. */
export function removeChild(parent: string, name: string, judged: Identity, hooks: RemoveHooks = {}): Removal {
	const d = detachChild(parent, name, judged, hooks);
	return d.kind === "detached" ? purgeDetached(d) : d;
}

/**
 * Undo detachChild when the caller keeps the tree (its archive failed): rename it back to its name when nothing took that
 * name meanwhile. `at` is where the tree is now. Never throws.
 */
export function restoreDetached(d: Detached): { at: string; said: string } {
	return putBack(d.doomed, d.path);
}

/** Rename `from` back to `to` when nothing took `to` meanwhile (a rename onto an empty directory would replace it); says what became of it. */
function putBack(from: string, to: string): { at: string; said: string } {
	try {
		lstatSync(to);
		return { at: from, said: `left at ${from}: ${to} exists again` };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { at: from, said: `left at ${from}: ${to} cannot be checked (${message(e)})` };
	}
	try {
		renameSync(from, to);
		return { at: to, said: `renamed back to ${to}` };
	} catch (e) {
		return { at: from, said: `left at ${from}: renaming back failed (${message(e)})` };
	}
}

/**
 * The newest lstat mtime under `dir` (itself included; links are not followed), stopping at the first one later than
 * `after`. An entry that cannot be read counts as changed now: an unreadable tree is never judged idle.
 */
export function newestChange(dir: string, after: number): number {
	let newest = 0;
	const stack = [dir];
	while (stack.length > 0) {
		const at = stack.pop()!;
		try {
			const st = lstatSync(at);
			newest = Math.max(newest, st.mtimeMs);
			if (newest > after) return newest;
			if (st.isDirectory()) for (const name of readdirSync(at)) stack.push(join(at, name));
		} catch {
			return Date.now();
		}
	}
	return newest;
}
