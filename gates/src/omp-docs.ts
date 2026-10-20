// The OMP docs and their snapshot line (PLAN wl-mv8k0fby51uakg D8). An OMP doc teaches how OMP
// behaves, so it is true of one OMP version: every one opens with
// `snapshot of OMP <x.y.z>, <yyyy-mm-dd>; drift will occur`. Which files are OMP docs is a path rule,
// not a hand list, so a new doc is covered the day it is added. Two checks read this module: the
// suite (ledger/test/omp-harness.test.ts: every matched doc carries the line at MEASURED_HOST) and
// the gates at session start (extensions/omp-docs-stale.ts: a doc whose snapshot is not the running
// OMP puts a notice in every model request). Pure: no file is read here.

/** A doc's snapshot line, parsed. */
export interface SnapshotHeader {
	/** The OMP version the doc was verified on, `x.y.z`. */
	version: string;
	/** The day it was verified, `yyyy-mm-dd`. */
	date: string;
}

/** A doc and the OMP version its snapshot line names. */
export interface VersionedDoc {
	/** How the doc is named to the reader (a path). */
	name: string;
	version: string;
}

const SNAPSHOT = /^snapshot of OMP (\d+\.\d+\.\d+), (\d{4}-\d{2}-\d{2}); drift will occur$/;

/**
 * Vendored OMP docs: byte-identical copies of upstream files under `plugins/` (plugins/VENDOR.md
 * "Every other file is byte-identical to the pin"), so their snapshot line belongs upstream, in
 * jo-wolff-plugins. They are exempt until upstream adds it; the suite holds this list to `plugins/`
 * paths, so it cannot exempt a doc this repo owns.
 */
export const VENDORED_OMP_DOCS: readonly string[] = ["plugins/i-have-audhd/omp/REGISTRATION.md"];

/**
 * Whether a repo-relative path is an OMP doc: `profile/OMP-*.md`, the card `profile/AGENTS.md`, any
 * `.md` under a directory named `omp`, or `docs/omp-*.md`.
 */
export function isOmpDoc(path: string): boolean {
	if (!path.endsWith(".md")) return false;
	const parts = path.split("/");
	const base = parts.at(-1)!;
	if (parts.length === 2 && parts[0] === "profile") return base === "AGENTS.md" || base.startsWith("OMP-");
	if (parts.length === 2 && parts[0] === "docs" && base.startsWith("omp-")) return true;
	return parts.slice(0, -1).includes("omp");
}

/** The OMP docs among a repo's tracked files (repo-relative, `git ls-files` form), each with its absolute path under `root`. */
export function ompDocs(root: string, tracked: readonly string[]): { rel: string; path: string }[] {
	const base = root.endsWith("/") ? root.slice(0, -1) : root;
	return tracked.filter(isOmpDoc).map((rel) => ({ rel, path: `${base}/${rel}` }));
}

/** The snapshot line's version and date, or null when `line` is not one. A trailing CR is ignored. */
export function parseSnapshotLine(line: string): SnapshotHeader | null {
	const m = SNAPSHOT.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
	return m ? { version: m[1]!, date: m[2]! } : null;
}

/** The docs whose snapshot is not `runningVersion`, patch included: 18.8.6 is stale on 18.8.7. */
export function staleDocs<D extends VersionedDoc>(runningVersion: string, docs: readonly D[]): D[] {
	return docs.filter((d) => d.version !== runningVersion);
}

/** The notice the model gets while a doc is stale: one line per stale doc. */
export function staleNotice(runningVersion: string, stale: readonly VersionedDoc[]): string {
	return stale
		.map((d) => `OMP docs are stale: ${d.name} is a snapshot of OMP ${d.version}, running OMP is ${runningVersion}. Verify any OMP claim against OMP source or omp:// docs before relying on it.`)
		.join("\n");
}
