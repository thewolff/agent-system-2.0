// Manifest sync (M4 fix round 4, S7; triad 1, cold read): every file under gates/, tiers/,
// classifier/, surface/, ledger/ and skills/ has a row in install/manifest.tsv, so a new file fails here in
// `bun test` before it fails install/install.sh on a fresh machine (surface/ and ledger/ added with
// MIGRATION.md item 24: lanes add most new files there; skills/ added with migration/items/seo-audit-skill.md, the seo-audit skill and its
// fixtures). The walk mirrors install.sh's own
// (`find -type f`, skipping .DS_Store and anything under node_modules). The manifest is read, never written.
// Since PR-P (PLAN wl-mv654hoqwpfhmo § 11.3, day one) a row may carry a fourth `proposal_id` column: `-` on a row no
// proposal made, else the proposal's `p-…` id; a three-column row reads as `-`. `manifestRows` is the reader that checks it.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const DIRS = ["gates", "tiers", "classifier", "surface", "ledger", "skills"];
const MANIFEST = join(REPO, "install", "manifest.tsv");
const COLUMNS = ["path", "kind", "destination", "proposal_id"] as const;
const PROPOSAL_ID = /^(?:-|p-[a-z0-9]+)$/;

interface ManifestRow {
	line: number;
	path: string;
	kind: string;
	destination: string;
	proposalId: string;
}

/** Every line of manifest text that breaks install.sh's shape (1-based line numbers): the header, then each row of three or four non-empty fields. */
function manifestProblems(text: string): string[] {
	const problems: string[] = [];
	let header = false;
	text.split("\n").forEach((l, i) => {
		if (l === "" || l.startsWith("#")) return;
		const fields = l.split("\t");
		if (!header) {
			header = true;
			if (l !== COLUMNS.join("\t")) problems.push(`manifest line ${i + 1}: header is not ${COLUMNS.join("<TAB>")}: ${l}`);
			return;
		}
		if (fields.length < 3 || fields.length > COLUMNS.length || fields.includes("")) problems.push(`manifest line ${i + 1}: ${fields.length} fields, need 3 or 4, none empty (the 4th is the optional proposal_id): ${l}`);
		else if (fields.length === 4 && !PROPOSAL_ID.test(fields[3]!)) problems.push(`manifest line ${i + 1}: proposal_id '${fields[3]}' is neither - nor a p- id: ${l}`);
	});
	if (!header) problems.push("manifest has no header row");
	return problems;
}

/** The rows of manifest text, a three-column row's proposalId `-`; throws naming the first offending line (see `manifestProblems`). */
function manifestRows(text: string): ManifestRow[] {
	const problems = manifestProblems(text);
	if (problems.length > 0) throw new Error(problems[0]);
	const rows: ManifestRow[] = [];
	let header = false;
	text.split("\n").forEach((l, i) => {
		if (l === "" || l.startsWith("#")) return;
		if (!header) {
			header = true;
			return;
		}
		const [path, kind, destination, proposalId = "-"] = l.split("\t") as [string, string, string, string?];
		rows.push({ line: i + 1, path, kind, destination, proposalId });
	});
	return rows;
}

function files(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".DS_Store") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...files(p));
		else if (e.isFile()) out.push(relative(REPO, p));
	}
	return out;
}

test("every file under gates/, tiers/, classifier/, surface/, ledger/ and skills/ has an install/manifest.tsv row", () => {
	const rows = new Set(manifestRows(readFileSync(MANIFEST, "utf8")).map((r) => r.path));
	const missing = DIRS.flatMap((d) => files(join(REPO, d))).filter((f) => !rows.has(f)).sort();
	expect(missing).toEqual([]);
});

test("every install/manifest.tsv row has three or four fields, a present proposal_id - or a proposal's p- id (PLAN wl-mv654hoqwpfhmo § 11.3, PR-P)", () => {
	const problems = manifestProblems(readFileSync(MANIFEST, "utf8"));
	expect({ count: problems.length, first: problems.slice(0, 5) }).toEqual({ count: 0, first: [] });
});

test("the manifest reader reads a three-column row as proposal_id -, takes - or a p- id, and rejects an empty or malformed one, a fifth field and a header without the column", () => {
	const text = readFileSync(MANIFEST, "utf8");
	expect(() => manifestRows(text)).not.toThrow();
	const lines = text.split("\n");
	const headerAt = lines.findIndex((l) => l !== "" && !l.startsWith("#"));
	const rowAt = lines.findIndex((l, i) => i > headerAt && l !== "" && !l.startsWith("#"));
	const fields = lines[rowAt]!.split("\t").slice(0, 3);
	const withRow = (row: string) => lines.map((l, i) => (i === rowAt ? row : l)).join("\n");
	const proposalOf = (row: string) => manifestRows(withRow(row)).find((r) => r.line === rowAt + 1)?.proposalId;
	// a three-column row reads as proposal_id -; a fourth column of - or a proposal's id is taken as written
	expect(proposalOf(fields.join("\t"))).toBe("-");
	expect(proposalOf([...fields, "-"].join("\t"))).toBe("-");
	expect(proposalOf([...fields, "p-mv0abc123"].join("\t"))).toBe("p-mv0abc123");
	// the column present but empty, or not a proposal id, or a fifth field
	expect(() => manifestRows(withRow([...fields, ""].join("\t")))).toThrow(`manifest line ${rowAt + 1}: 4 fields, need 3 or 4, none empty`);
	expect(() => manifestRows(withRow([...fields, "proposal-1"].join("\t")))).toThrow(`manifest line ${rowAt + 1}: proposal_id 'proposal-1'`);
	expect(() => manifestRows(withRow([...fields, "-", "extra"].join("\t")))).toThrow(`manifest line ${rowAt + 1}: 5 fields, need 3 or 4`);
	// the header without the column
	const oldHeader = lines.map((l, i) => (i === headerAt ? "path\tkind\tdestination" : l)).join("\n");
	expect(() => manifestRows(oldHeader)).toThrow(`manifest line ${headerAt + 1}: header is not path<TAB>kind<TAB>destination<TAB>proposal_id`);
});
