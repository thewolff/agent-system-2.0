// The merge train's resolver (workload wl-mv8s8srodefytc, PLAN § 3): the logic behind
// surface/scripts/merge-train.ts. It works on stage blobs and whole files, never on the conflict
// markers git leaves in the working tree. Sides: base = the merge base (stage 1), pr = the PR head
// (stage 2, HEAD), main = origin/main (stage 3, MERGE_HEAD).
//
// An item block is a legacy item line (`^\d+\. \*\*` inside `## M7 follow-ups`, as scanLegacy finds
// it) plus every following line that is indented, or blank lines followed by an indented line, up to
// the next line at column 0. A new item is an item block on the pr side whose number is not a legacy
// number on base. Numbers count with multiplicity: when the pr side holds a number more often than
// base (a PR item that git merged cleanly beside main's item of the same number), the surplus blocks,
// those whose item line base lacks, are new too. `split` takes the new blocks out of the pr side; each
// becomes migration/items/<slug>.md with the four-key header (surface/src/migration-items.ts).
//
// Exit codes (the CLI's): 0 done; 2 a usage error or a git process failure (a failed `git merge-file`
// is reported here, apart from a conflict count); 3 an unmerged path outside the auto-fix set
// {MIGRATION.md, install/manifest.tsv, migration/items/*}; 4 a conflict it cannot fix without losing a
// side's edit. On 2, 3 and 4 nothing is written. No network, no push, no ledger.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ITEMS_DIR, isSlug, type LegacyItem, MIGRATION_FILE, parseItem, SLUG_MAX, scanLegacy } from "./migration-items";

export const MANIFEST_FILE = "install/manifest.tsv";
export const EXIT_USAGE = 2;
export const EXIT_OUTSIDE = 3;
export const EXIT_LOSES = 4;

/** The marker length handed to `git merge-file`, far past git's 7 so no file line can pass for one. */
const MARKER_SIZE = 40;
const OPEN = "<".repeat(MARKER_SIZE);
const BASE_MARK = "|".repeat(MARKER_SIZE);
const SEP = "=".repeat(MARKER_SIZE);
const CLOSE = ">".repeat(MARKER_SIZE);
/** git's own conflict markers, as the postcondition looks for them in every file it writes. */
const GIT_MARKER_RE = /^(<{7}|>{7}|\|{7})( |$)|^={7}$/;
const LEAD_RE = /^(\d+)\. \*\*(.+?)\*\*(.*)$/;
/** A `--workload` value: the head branch's workload id, or `none` (as parseItem accepts). */
export const WORKLOAD_RE = /^(wl-[a-z0-9]+|none)$/;

/** A refusal: the CLI prints the message to stderr and exits with the code. Nothing was written. */
export class TrainExit extends Error {
	constructor(
		message: string,
		readonly code: number,
	) {
		super(message);
	}
}

/** What a command prints on success: stdout lines (one per path written) and stderr notes. */
export interface Outcome {
	out: string[];
	err: string[];
}

export interface ItemBlock {
	number: number;
	/** 0-based index of the item line in the text's lines. */
	start: number;
	lines: string[];
}

export interface ItemFileOut {
	number: number;
	slug: string;
	path: string;
	text: string;
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function isIndented(line: string): boolean {
	return /^[ \t]/.test(line) && !isBlank(line);
}

/** Every item block of a MIGRATION.md text, in file order. */
export function itemBlocks(migration: string): ItemBlock[] {
	const lines = migration.split("\n");
	return scanLegacy(migration).map(({ number, line }) => {
		const start = line - 1;
		let end = start + 1;
		let j = start + 1;
		while (j < lines.length) {
			if (isIndented(lines[j]!)) {
				j++;
				end = j;
				continue;
			}
			if (isBlank(lines[j]!)) {
				let k = j;
				while (k < lines.length && isBlank(lines[k]!)) k++;
				if (k < lines.length && isIndented(lines[k]!)) {
					j = k;
					continue;
				}
			}
			break;
		}
		return { number, start, lines: lines.slice(start, end) };
	});
}

/**
 * The conversion core: the pr side with every new item block removed (`rest`), and those blocks.
 * Where a removed block sat between two blank lines, one of them goes with it, so a PR that added
 * `\n<item>` leaves the pr side as base had it. `ambiguous`: numbers the pr side holds more often
 * than base where the item lines do not tell which blocks are the new ones.
 */
export function split(pr: string, base: string): { rest: string; blocks: ItemBlock[]; ambiguous: number[] } {
	const onBase = new Map<number, string[]>();
	for (const b of itemBlocks(base)) onBase.set(b.number, [...(onBase.get(b.number) ?? []), b.lines[0]!]);
	const onPr = new Map<number, ItemBlock[]>();
	for (const b of itemBlocks(pr)) onPr.set(b.number, [...(onPr.get(b.number) ?? []), b]);
	const blocks: ItemBlock[] = [];
	const ambiguous: number[] = [];
	for (const [n, mine] of onPr) {
		const theirs = onBase.get(n) ?? [];
		if (mine.length <= theirs.length) continue;
		const fresh = mine.filter((b) => !theirs.includes(b.lines[0]!));
		if (fresh.length === mine.length - theirs.length) blocks.push(...fresh);
		else ambiguous.push(n);
	}
	blocks.sort((x, y) => x.start - y.start);
	const lines = pr.split("\n");
	for (const b of [...blocks].reverse()) {
		lines.splice(b.start, b.lines.length);
		if (b.start > 0 && b.start < lines.length && isBlank(lines[b.start - 1]!) && isBlank(lines[b.start]!)) lines.splice(b.start, 1);
	}
	return { rest: lines.join("\n"), blocks, ambiguous };
}

/** Kebab of a title, cut at a word boundary within SLUG_MAX; "" when the title has no letter or digit. */
export function slugOf(title: string): string {
	const words = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let slug = "";
	for (const w of words) {
		const next = slug ? `${slug}-${w}` : w;
		if (next.length > SLUG_MAX) break;
		slug = next;
	}
	if (slug === "" && words.length > 0) slug = words[0]!.slice(0, SLUG_MAX);
	return slug;
}

/**
 * The item file a new block becomes, or the reason it cannot. Title: the bold lead, its trailing
 * period dropped. Body: the rest of the item line, then the continuation lines with their common
 * indent removed (the list item's content indent: four spaces under a two-digit number, five under
 * a three-digit one), `PR pending` → `PR #<n>`.
 */
export function itemFile(block: ItemBlock, workload: string, pr: number): ItemFileOut | { error: string } {
	const m = LEAD_RE.exec(block.lines[0]!);
	if (!m) return { error: `item ${block.number} has no closed bold lead (\`${block.number}. **Title.** …\`)` };
	let title = m[2]!.trim();
	if (title.endsWith(".")) title = title.slice(0, -1).trimEnd();
	const cont = block.lines.slice(1);
	const indents = cont.filter((l) => !isBlank(l)).map((l) => /^[ \t]*/.exec(l)![0].length);
	const indent = indents.length ? Math.min(...indents) : 0;
	const body = [m[3]!.trim(), ...cont.map((l) => (isBlank(l) ? "" : l.slice(indent)))];
	while (body.length > 0 && body[0] === "") body.shift();
	const text = `---\ntitle: ${title}\nstatus: building\nworkload: ${workload}\npr: ${pr}\n---\n${body.join("\n").replace(/PR pending/g, `PR #${pr}`)}\n`;
	const parsed = parseItem(text);
	if (parsed.errors.length) return { error: `item ${block.number}: the item file would not parse: ${parsed.errors.join("; ")}` };
	const slug = slugOf(title);
	if (!isSlug(slug)) return { error: `item ${block.number}: the title \`${title}\` gives no valid slug` };
	return { number: block.number, slug, path: `${ITEMS_DIR}/${slug}.md`, text };
}

/** One conflict hunk of `git merge-file -p` output read with MARKER_SIZE; `base` only in diff3 style. */
export interface Hunk {
	/** 1-based line of the opening marker in the merge output. */
	line: number;
	pr: string[];
	base: string[] | null;
	main: string[];
}

function isMarker(line: string, mark: string): boolean {
	return line.startsWith(mark) && (line.length === mark.length || line[mark.length] === " ");
}

/** The merge output as clean lines and hunks, in order. */
export function parseMerged(text: string): Array<string | Hunk> {
	const out: Array<string | Hunk> = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const l = lines[i]!;
		if (!isMarker(l, OPEN)) {
			out.push(l);
			i++;
			continue;
		}
		const hunk: Hunk = { line: i + 1, pr: [], base: null, main: [] };
		let side: string[] = hunk.pr;
		for (i++; i < lines.length && !isMarker(lines[i]!, CLOSE); i++) {
			const h = lines[i]!;
			if (isMarker(h, BASE_MARK)) side = hunk.base = [];
			else if (h === SEP) side = hunk.main;
			else side.push(h);
		}
		i++;
		out.push(hunk);
	}
	return out;
}

interface GitResult {
	code: number | null;
	out: string;
	err: string;
}

function git(repo: string, args: string[]): GitResult {
	const r = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** git that must succeed: its stdout, else exit 2 naming the command. */
function gitOk(repo: string, args: string[]): string {
	const r = git(repo, args);
	if (r.code !== 0) throw new TrainExit(`git ${args.join(" ")} failed (exit ${r.code ?? "signal"}): ${r.err.trim().split("\n").at(-1) ?? ""}`, EXIT_USAGE);
	return r.out;
}

/** A blob's text by revision spec (`:2:MIGRATION.md`, `HEAD:MIGRATION.md`), or null when absent. */
function blob(repo: string, spec: string): string | null {
	return git(repo, ["cat-file", "-e", spec]).code === 0 ? gitOk(repo, ["cat-file", "blob", spec]) : null;
}

function commitOf(repo: string, ref: string): string {
	const r = git(repo, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
	if (r.code !== 0) throw new TrainExit(`${ref} is not a commit`, EXIT_USAGE);
	return r.out.trim();
}

function mergeBase(repo: string, ref: string): string {
	const r = git(repo, ["merge-base", "HEAD", commitOf(repo, ref)]);
	if (r.code !== 0) throw new TrainExit(`HEAD and ${ref} have no merge base`, EXIT_USAGE);
	return r.out.trim();
}

/** Unmerged paths from `git ls-files -u`: path → stage number → blob id. */
function unmergedPaths(repo: string): Map<string, Map<number, string>> {
	const out = new Map<string, Map<number, string>>();
	for (const entry of gitOk(repo, ["ls-files", "-u", "-z"]).split("\0")) {
		if (entry === "") continue;
		const tab = entry.indexOf("\t");
		const [, sha, stage] = entry.slice(0, tab).split(" ");
		const path = entry.slice(tab + 1);
		if (!out.has(path)) out.set(path, new Map());
		out.get(path)!.set(Number(stage), sha!);
	}
	return out;
}

/**
 * `git merge-file -p pr base main` on temp copies of the three texts. Exit 0 is clean and 1..127 the
 * conflict count; anything else (git's negative error status, a signal) is a process failure,
 * reported as exit 2 and never read as conflicts.
 */
export function mergeFile(repo: string, name: string, pr: string, base: string, main: string, diff3: boolean): { text: string; conflicts: number } {
	for (const [side, text] of [["pr", pr], ["base", base], ["main", main]] as const) {
		const bad = text.split("\n").find((l) => [OPEN, BASE_MARK, SEP, CLOSE].some((m) => l.startsWith(m)));
		if (bad !== undefined) throw new TrainExit(`${name}: the ${side} side holds a line that reads as a ${MARKER_SIZE}-character merge marker`, EXIT_LOSES);
	}
	const dir = mkdtempSync(join(tmpdir(), "as2-merge-train-"));
	try {
		const files = ["pr", "base", "main"].map((s) => join(dir, s));
		writeFileSync(files[0]!, pr);
		writeFileSync(files[1]!, base);
		writeFileSync(files[2]!, main);
		const style = diff3 ? ["--diff3"] : [];
		const r = git(repo, ["merge-file", "-p", "-q", ...style, `--marker-size=${MARKER_SIZE}`, "-L", "pr", "-L", "base", "-L", "main", ...files]);
		if (r.code === null || r.code < 0 || r.code > 127) {
			throw new TrainExit(
				`${name}: git merge-file failed (exit ${r.code ?? "signal"}), a process failure, not a conflict count: ${r.err.trim() || "no message"}`,
				EXIT_USAGE,
			);
		}
		return { text: r.out, conflicts: r.code };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A hunk named by its line and the first non-blank line of each side, each cut to 100 characters. */
function hunkReason(name: string, h: Hunk): string {
	const [pr, main] = [h.pr, h.main].map((side) => {
		const first = side.find((l) => !isBlank(l)) ?? "(nothing)";
		return first.length > 100 ? `${first.slice(0, 97)}...` : first;
	});
	return `${name}: both sides changed the lines at line ${h.line} of the 3-way merge: pr \`${pr}\`, main \`${main}\``;
}

/**
 * install/manifest.tsv after its 3-way merge: a hunk where both sides only add rows (an empty base
 * section) takes main's rows, then the PR's rows not already present; any other hunk is a reason.
 */
export function unionManifest(merged: string): { text: string; reasons: string[] } {
	const parts = parseMerged(merged);
	const clean = new Set(parts.filter((p): p is string => typeof p === "string"));
	const lines: string[] = [];
	const reasons: string[] = [];
	for (const p of parts) {
		if (typeof p === "string") {
			lines.push(p);
			continue;
		}
		if (p.base === null || p.base.length > 0) {
			reasons.push(hunkReason(MANIFEST_FILE, p));
			continue;
		}
		const seen = new Set([...clean, ...p.main]);
		lines.push(...p.main, ...p.pr.filter((r) => !seen.has(r)));
	}
	return { text: lines.join("\n"), reasons };
}

function markerReasons(writes: Map<string, string>): string[] {
	const reasons: string[] = [];
	for (const [path, text] of writes) {
		const i = text.split("\n").findIndex((l) => GIT_MARKER_RE.test(l));
		if (i !== -1) reasons.push(`${path}: line ${i + 1} would be a conflict marker`);
	}
	return reasons;
}

/**
 * The numbered items of `text` beyond what `against` holds, counting each number with multiplicity:
 * per number, the occurrences past `against`'s count, those whose item line `against` lacks first.
 */
export function surplusItems(text: string, against: string): LegacyItem[] {
	const againstLines = against.split("\n");
	const known = new Map<number, string[]>();
	for (const i of scanLegacy(against)) known.set(i.number, [...(known.get(i.number) ?? []), againstLines[i.line - 1]!]);
	const textLines = text.split("\n");
	const mine = new Map<number, LegacyItem[]>();
	for (const i of scanLegacy(text)) mine.set(i.number, [...(mine.get(i.number) ?? []), i]);
	const out: LegacyItem[] = [];
	for (const [n, items] of mine) {
		const theirs = known.get(n) ?? [];
		if (items.length <= theirs.length) continue;
		const isKnown = (i: LegacyItem) => theirs.includes(textLines[i.line - 1]!);
		out.push(...[...items.filter((i) => !isKnown(i)), ...items.filter(isKnown)].slice(0, items.length - theirs.length));
	}
	return out.sort((a, b) => a.line - b.line);
}

/** The item files of the new blocks, with every collision and malformed block as a reason. */
function itemFiles(repo: string, blocks: ItemBlock[], workload: string, pr: number, trees: string[], reasons: string[]): ItemFileOut[] {
	const out: ItemFileOut[] = [];
	const bySlug = new Map<string, number>();
	for (const b of blocks) {
		const f = itemFile(b, workload, pr);
		if ("error" in f) {
			reasons.push(`${MIGRATION_FILE}: ${f.error}`);
			continue;
		}
		const twin = bySlug.get(f.slug);
		if (twin !== undefined) reasons.push(`${f.path}: items ${twin} and ${f.number} give the same slug`);
		else bySlug.set(f.slug, f.number);
		const holder = trees.find((t) => git(repo, ["cat-file", "-e", `${t}:${f.path}`]).code === 0);
		if (holder) reasons.push(`${f.path}: item ${f.number}'s slug already exists on ${holder}`);
		else if (existsSync(join(repo, f.path))) reasons.push(`${f.path}: item ${f.number}'s slug already exists in the working tree`);
		out.push(f);
	}
	return out;
}

/**
 * Writes every path, then (`stage`) `git add`s them all in one call. All or nothing: when a write or
 * the add fails, each path gets its prior bytes back (or is removed when it did not exist), each
 * directory made here is removed when empty, and the failure is rethrown with its own code and
 * message. A failed `git add` leaves the index as it was: git writes it under index.lock or not at all.
 */
function commitWrites(repo: string, writes: Map<string, string>, stage: boolean): void {
	const prior = new Map<string, Buffer | null>();
	const made = new Set<string>();
	try {
		for (const [path, text] of writes) {
			const abs = join(repo, path);
			for (let d = dirname(abs); d !== repo && d.startsWith(`${repo}/`) && !existsSync(d); d = dirname(d)) made.add(d);
			prior.set(path, existsSync(abs) ? readFileSync(abs) : null);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		}
		if (stage) gitOk(repo, ["add", "--", ...writes.keys()]);
	} catch (e) {
		const stuck: string[] = [];
		for (const [path, bytes] of prior) {
			try {
				if (bytes === null) rmSync(join(repo, path), { force: true });
				else writeFileSync(join(repo, path), bytes);
			} catch {
				stuck.push(path);
			}
		}
		for (const d of [...made].sort((a, b) => b.length - a.length)) {
			try {
				rmdirSync(d);
			} catch {
				// not empty, or already gone: leave it
			}
		}
		if (stuck.length === 0) throw e;
		const note = `\n  and could not restore: ${stuck.join(", ")}`;
		if (e instanceof TrainExit) throw new TrainExit(e.message + note, e.code);
		throw new Error(`${e instanceof Error ? e.message : String(e)}${note}`, { cause: e });
	}
}

function inAutoFixSet(path: string): boolean {
	if (path === MIGRATION_FILE || path === MANIFEST_FILE) return true;
	const prefix = `${ITEMS_DIR}/`;
	return path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
}

/**
 * `resolve --pr <n> --workload <wl|none>`, merge in progress: resolves MIGRATION.md,
 * install/manifest.tsv and migration/items/* from their stage blobs, writes and `git add`s them.
 */
export function resolveMerge(repo: string, pr: number, workload: string): Outcome {
	if (git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code !== 0) throw new TrainExit("resolve: no merge in progress (MERGE_HEAD is absent)", EXIT_USAGE);
	const unmerged = unmergedPaths(repo);
	const outside = [...unmerged.keys()].filter((p) => !inAutoFixSet(p));
	if (outside.length) {
		throw new TrainExit(
			[`resolve: nothing written; conflicts outside ${MIGRATION_FILE}, ${MANIFEST_FILE} and ${ITEMS_DIR}/*:`, ...outside.map((p) => `  ${p}`)].join("\n"),
			EXIT_OUTSIDE,
		);
	}
	if (unmerged.size === 0) return { out: [], err: ["resolve: no unmerged path"] };
	const writes = new Map<string, string>();
	const reasons: string[] = [];
	const sides = (path: string): { base: string; pr: string; main: string } | null => {
		const stages = unmerged.get(path)!;
		if (!stages.has(2) || !stages.has(3)) {
			reasons.push(`${path}: one side deleted it and the other changed it`);
			return null;
		}
		return {
			base: stages.has(1) ? blob(repo, `:1:${path}`)! : "",
			pr: blob(repo, `:2:${path}`)!,
			main: blob(repo, `:3:${path}`)!,
		};
	};
	for (const path of [...unmerged.keys()].filter((p) => p.startsWith(`${ITEMS_DIR}/`))) {
		const stages = unmerged.get(path)!;
		if (stages.has(1) || !stages.has(2) || !stages.has(3)) reasons.push(`${path}: changed on both sides (not an add/add)`);
		else if (stages.get(2) !== stages.get(3)) reasons.push(`${path}: added on both sides with different text`);
		else writes.set(path, blob(repo, `:2:${path}`)!);
	}
	if (unmerged.has(MIGRATION_FILE)) {
		const s = sides(MIGRATION_FILE);
		if (s) {
			const { rest, blocks, ambiguous } = split(s.pr, s.base);
			for (const n of ambiguous) reasons.push(`${MIGRATION_FILE}: item ${n} appears more often on the pr side than on base, and its item lines do not tell which is new`);
			const items = itemFiles(repo, blocks, workload, pr, ["HEAD", "MERGE_HEAD"], reasons);
			const merged = mergeFile(repo, MIGRATION_FILE, rest, s.base, s.main, false);
			if (merged.conflicts > 0) {
				for (const p of parseMerged(merged.text)) if (typeof p !== "string") reasons.push(hunkReason(MIGRATION_FILE, p));
			} else {
				for (const i of surplusItems(merged.text, s.main)) reasons.push(`${MIGRATION_FILE}: line ${i.line} would keep item ${i.number}, which main lacks`);
			}
			writes.set(MIGRATION_FILE, merged.text);
			for (const f of items) writes.set(f.path, f.text);
		}
	}
	if (unmerged.has(MANIFEST_FILE)) {
		const s = sides(MANIFEST_FILE);
		if (s) {
			const merged = mergeFile(repo, MANIFEST_FILE, s.pr, s.base, s.main, true);
			if (merged.conflicts > 0) {
				const u = unionManifest(merged.text);
				reasons.push(...u.reasons);
				writes.set(MANIFEST_FILE, u.text);
			} else writes.set(MANIFEST_FILE, merged.text);
		}
	}
	if (reasons.length === 0) reasons.push(...markerReasons(writes));
	if (reasons.length) throw new TrainExit(["resolve: nothing written; it cannot fix this without losing a side's edit:", ...reasons.map((r) => `  ${r}`)].join("\n"), EXIT_LOSES);
	commitWrites(repo, writes, true);
	return { out: [...writes.keys()], err: [] };
}

/**
 * `convert --pr <n> --workload <wl|none> --base <ref>`, no merge in progress: splits HEAD's
 * MIGRATION.md against `git merge-base HEAD <ref>` and writes the rest and the item files.
 */
export function convertItems(repo: string, pr: number, workload: string, base: string): Outcome {
	if (git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0 || unmergedPaths(repo).size > 0) {
		throw new TrainExit("convert: a merge is in progress; run resolve, then commit", EXIT_USAGE);
	}
	const mb = mergeBase(repo, base);
	const head = blob(repo, `HEAD:${MIGRATION_FILE}`);
	if (head === null) return { out: [], err: [`convert: nothing to do (HEAD has no ${MIGRATION_FILE})`] };
	const { rest, blocks, ambiguous } = split(head, blob(repo, `${mb}:${MIGRATION_FILE}`) ?? "");
	if (blocks.length === 0 && ambiguous.length === 0) return { out: [], err: ["convert: nothing to do"] };
	const reasons = ambiguous.map((n) => `${MIGRATION_FILE}: item ${n} appears more often on HEAD than on the merge base, and its item lines do not tell which is new`);
	const onDisk = existsSync(join(repo, MIGRATION_FILE)) ? readFileSync(join(repo, MIGRATION_FILE), "utf8") : null;
	if (onDisk !== head) reasons.push(`${MIGRATION_FILE}: the working tree differs from HEAD; commit or discard that change first`);
	const items = itemFiles(repo, blocks, workload, pr, ["HEAD", commitOf(repo, base)], reasons);
	const writes = new Map<string, string>([[MIGRATION_FILE, rest]]);
	for (const f of items) writes.set(f.path, f.text);
	if (reasons.length === 0) reasons.push(...markerReasons(writes));
	if (reasons.length) throw new TrainExit(["convert: nothing written:", ...reasons.map((r) => `  ${r}`)].join("\n"), EXIT_LOSES);
	commitWrites(repo, writes, false);
	return { out: [...writes.keys()], err: [] };
}

/**
 * `check --base <ref>`: HEAD's MIGRATION.md holds no legacy item number absent from the merge base's,
 * counted with multiplicity (a new number at or below LEGACY_CEILING included, and a second item of a
 * number the base holds once). Exit 4 listing them.
 */
export function checkItems(repo: string, base: string): Outcome {
	const mb = mergeBase(repo, base);
	const added = surplusItems(blob(repo, `HEAD:${MIGRATION_FILE}`) ?? "", blob(repo, `${mb}:${MIGRATION_FILE}`) ?? "");
	if (added.length) {
		throw new TrainExit(
			[
				`check: HEAD's ${MIGRATION_FILE} adds numbered items absent from the merge base ${mb.slice(0, 12)}; convert them to ${ITEMS_DIR}/:`,
				...added.map((i) => `  ${MIGRATION_FILE}:${i.line}: item ${i.number}`),
			].join("\n"),
			EXIT_LOSES,
		);
	}
	return { out: [`check: ok (no numbered item added since the merge base ${mb.slice(0, 12)})`], err: [] };
}
