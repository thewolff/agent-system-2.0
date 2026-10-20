// P-11 row 10 (DESIGN-2.0.md:347; SPEC-2.0.md:322-324 § B2): raw writes to the ledger database
// outside the ledger module are refused — a `sqlite3` (or any other raw CLI) command naming the
// ledger file, a shell redirect into it, eval code opening or writing it, or a file-tool write to it
// or to its `-wal`/`-shm`/`-journal` siblings. The path is the module's own: LEDGER_DB_ENV,
// defaultLedgerPath and canonicalPath from ledger/src/locality.ts; the siblings are derived by suffix.
//
// No text grants authority (astra review B2): a comment naming `ledger/src/index` or a trailing
// argument shaped like `ledger/scripts/x.ts` authorises nothing. The one exemption is running a
// script that canonically resolves inside this repository's `ledger/scripts/`, as the one program bun
// or node executes, with no inline code and no preloaded module.
//
// The row is the Jo-only boundary's layer 2 (PLAN wl-mv654hoqwpfhmo § 6.3 item 2, ledger/src/authority.ts),
// for every role: eval and inline code may not load the ledger module at all, a database opened from code may
// not name a `ledger.db` or sit under `.agent-system-2/`, and no call may set, unset or override the
// agent-context tags or the names that move the live roots. Every refusal names the boundary.
// G1 (scratch auth-forgery AUDIT.md § (e)), with its review round 1: a script an interpreter runs (bun, node,
// tsx, ts-node, bunx/npx on those, python, perl, ruby, deno) and the modules its options preload are read at gate
// time and judged by the same rules (scriptCrossing), and a module loaded by a specifier computed at run time is
// refused in eval, inline code and scripts outside every git repository (eval-code.ts computedModuleLoad).
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { BOUNDARY, boundaryEnvName } from "../../../ledger/src/authority";
import { canonicalPath, DEFAULT_LEDGER_RELATIVE, defaultLedgerPath, LEDGER_DB_ENV } from "../../../ledger/src/locality";
import { boundaryEnvWrite, type CodeFacts, callArgs, codeFacts, computedMember, computedModuleLoad, dbConstructorEscape, evalProcessStart, ledgerModuleImport, SPAWN_API, WRITE_API } from "../eval-code";
import { bashCommand, type CodeFamily, codeInterpreterEnv, type Exec, type Expansion, expandShell, gitCall, gitTraceFiles, interpreterArgs, interpreterEnv, interpreterFamily, READ_ONLY_HEADS, writeDestinations } from "../exec";
import type { Fragment, Word } from "../shell-parse";
import { writeTargets } from "../targets";
import type { CallContext, Refusal, ToolCall } from "../types";

const SIBLINGS = ["", "-wal", "-shm", "-journal"];

/** The module's own scripts: the only commands that may open the ledger file by path. */
const LEDGER_SCRIPTS = canonicalPath(resolve(import.meta.dir, "../../../ledger/scripts"));

/**
 * canonicalPath, or the lexical path when a component cannot be read (EACCES/EPERM): a gate must
 * not throw on a path the command or the configuration names, and a path this uid cannot resolve
 * it cannot open through either (item 24, run tr-0mv0ks648wy8d2q). Other errors still throw.
 */
function canonicalOrLexical(path: string): string {
	try {
		return canonicalPath(path);
	} catch (err) {
		if (err instanceof Error && "code" in err && (err.code === "EACCES" || err.code === "EPERM")) return resolve(path);
		throw err;
	}
}

export interface LedgerPaths {
	/** Absolute spellings of the ledger file (as configured, and canonical). */
	files: string[];
	/** Every string that names the ledger in a command: the files, `~`/`$HOME` spellings, the env var. */
	needles: string[];
}

export function ledgerPaths(env: Record<string, string | undefined>): LedgerPaths {
	const configured = defaultLedgerPath(env);
	const files = [...new Set([configured, canonicalOrLexical(configured)])];
	const needles = new Set<string>(files);
	const home = env.HOME;
	for (const f of files) {
		if (home && f.startsWith(`${home}/`)) {
			const rel = f.slice(home.length);
			for (const h of ["~", "$HOME", "${HOME}"]) needles.add(h + rel);
		}
	}
	needles.add(LEDGER_DB_ENV);
	return { files, needles: [...needles] };
}

/**
 * A file-resource path with any SQLite selector stripped (`ledger.db:workloads:wl-x` → `ledger.db`):
 * the underlying file is what a write reaches (astra review B2).
 */
function withoutSelector(path: string): string {
	const slash = path.lastIndexOf("/");
	const colon = path.indexOf(":", slash + 1);
	return colon > 0 ? path.slice(0, colon) : path;
}

/** Is `path` (resolved against `dir`) the ledger file or a sibling? */
function isLedgerFile(path: string, dir: string, paths: LedgerPaths): boolean {
	for (const p of new Set([path, withoutSelector(path)])) {
		const abs = resolve(dir, p);
		const canonical = canonicalOrLexical(abs);
		if (paths.files.some((f) => SIBLINGS.some((s) => abs === f + s || canonical === f + s))) return true;
	}
	return false;
}

/** Where a word is read: the directory it resolves against, and whether that directory is known (a `cd` the gate could not follow). */
type WordPlace = Pick<Exec, "dir" | "dirKnown">;

/**
 * A fragment's tail, normalized across the unknown middle (item 102, Kimi r3 F1): runs of `/`
 * collapsed, `.` components dropped, a trailing `/` dropped, and a `..` that follows a component of
 * the tail cancelling it. A `..` with nothing left in the tail before it cancels a component of the
 * unknown middle or of the head: those are counted in `up` and removed, and the tail then starts at a
 * component boundary. The tail's first piece, when the tail does not start with `/`, is glued to the
 * middle: a `..` that cancels it cancels the middle's last component, so it counts in `up` too. Every
 * step leaves the tail a suffix of what it was or the same path, so the test can only match more.
 */
function normalTail(raw: string): { tail: string; up: number } {
	const t = raw.replace(/\/{2,}/g, "/");
	const parts = t.split("/");
	const stack: string[] = [];
	/** stack[0] is the piece glued to the unknown middle (a leading `.` or `..` is read as a component: it then matches more). */
	let glued = parts[0] !== "" && parts[0] !== "." && parts[0] !== "..";
	let up = 0;
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part !== "..") stack.push(part);
		else if (stack.length === 0) up++;
		else {
			stack.pop();
			if (stack.length === 0 && glued) {
				glued = false;
				up++;
			}
		}
	}
	const body = stack.join("/");
	return { tail: up === 0 && body !== "" && t.startsWith("/") ? `/${body}` : body, up };
}

/** `h` with its last component removed: the incomplete one when `h` does not end with `/`, else the last completed one (`/` stays `/`). */
function upOne(h: string): string {
	if (h === "/") return h;
	const t = h.endsWith("/") ? h.slice(0, -1) : h;
	return t.slice(0, t.lastIndexOf("/") + 1);
}

/**
 * Can a value `head + <unknown middle> + tail` (Word.fragments, item 102) be the ledger file or a
 * sibling, with the known parts reaching the ledger rather than any path? For some target T (each
 * ledger file spelling, each with each sibling suffix), T must be spelled `A + M + tail` for some M
 * (compatible), and either A reaches T's directory or the tail covers T's whole file name (pinned):
 * the item's "a known prefix names the ledger or its directory", and the reading writeNamesLedger
 * gives a relative file name after an unknown `cd`.
 *
 * The head is split at its last `/` into a completed directory part P and an incomplete last
 * component L, which is never normalized (`/not-real/.` + M may be `/not-real/.ledger`). An absolute
 * head, or one in a known directory, is A = resolve(dir, P) + L, also with P canonical. A relative head
 * in an unknown directory is P normalized lexically with its leading `./` and `../` components dropped
 * (they still land in an unknown directory), plus L, and is matched against each suffix R of T that
 * starts at a component boundary. The raw head is tested too. The tail is normalTail's; each `..`
 * it counted may climb one component out of the head, so the heads from A up that many components are
 * all tested. When A ends with `/` and the tail starts with `/`, one of the two is dropped (an empty
 * middle leaves `//`, the same path). An empty head imposes no A. The value an empty middle leaves,
 * head + tail, is judged as a literal path as well (emptyMiddleMayBeLedger).
 */
function fragmentMayBeLedger(f: Fragment, at: WordPlace, paths: LedgerPaths): boolean {
	if (emptyMiddleMayBeLedger(f.head + f.tail, at, paths)) return true;
	const { tail, up } = normalTail(f.tail);
	const relative = f.head !== "" && !f.head.startsWith("/") && !at.dirKnown;
	const heads = new Set<string>([f.head]);
	if (f.head !== "") {
		const cut = f.head.lastIndexOf("/") + 1;
		const dir = f.head.slice(0, cut);
		const last = f.head.slice(cut);
		if (relative) heads.add((dir === "" ? "" : posix.normalize(dir).replace(/^(?:\.\.?\/)+/, "")) + last);
		else {
			const abs = resolve(at.dir, dir);
			for (const d of new Set([abs, canonicalOrLexical(abs)])) heads.add(d === "/" ? `/${last}` : `${d}/${last}`);
		}
	}
	for (let h of heads) {
		for (let k = 0; k <= up; k++, h = upOne(h)) {
			const tl = h.endsWith("/") && tail.startsWith("/") ? tail.slice(1) : tail;
			const rel = h !== "" && !h.startsWith("/") && !at.dirKnown;
			for (const file of paths.files) {
				for (const s of SIBLINGS) {
					const target = file + s;
					const name = basename(target).length;
					for (const r of rel ? suffixes(target) : [target]) {
						if (!r.startsWith(h) || !r.endsWith(tl) || r.length < h.length + tl.length) continue;
						const dirLength = rel ? r.lastIndexOf("/") : dirname(target).length;
						if ((h !== "" && h.length >= dirLength) || tl.length >= name) return true;
					}
				}
			}
		}
	}
	return false;
}

/** `p` and every suffix of it that starts just after a `/`: where a relative path in an unknown directory may begin. */
function suffixes(p: string): string[] {
	const out = [p];
	for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) out.push(p.slice(i + 1));
	return out;
}

/**
 * Is `lit`, the value a fragment takes when its unknown middle is empty, the ledger file or a sibling
 * (item 102 review r2: a `.` or `..` split across the middle, `/not-real/sub/.` + `./ledger.db`, is
 * whole only then)? An absolute `lit`, or one in a known directory, is judged as a literal destination
 * is (isLedgerFile). A relative one in an unknown directory is normalized lexically with its leading
 * `./` and `../` components dropped (they stay in the unknown directory) and must equal a suffix of a
 * target that starts at a component boundary. An empty `lit` is not judged.
 */
function emptyMiddleMayBeLedger(lit: string, at: WordPlace, paths: LedgerPaths): boolean {
	if (lit === "") return false;
	if (lit.startsWith("/") || at.dirKnown) return isLedgerFile(lit, at.dir, paths);
	const rel = posix.normalize(lit).replace(/^(?:\.\.?\/)+/, "");
	return paths.files.some((file) => SIBLINGS.some((s) => suffixes(file + s).includes(rel)));
}

/**
 * Does a word name the ledger: a needle anywhere in it, a path to the file or a sibling, for a word
 * whose value is one of several a `case` left (Word.candidates) any candidate that does, or any of its
 * values with an unknown middle that may be it (Word.fragments, fragmentMayBeLedger; item 102)?
 */
function wordNamesLedger(w: Word, at: WordPlace, paths: LedgerPaths): boolean {
	if (paths.needles.some((n) => w.text.includes(n))) return true;
	if (w.fragments?.some((f) => fragmentMayBeLedger(f, at, paths))) return true;
	if (w.candidates) return w.candidates.some((c) => paths.needles.some((n) => c.includes(n)) || (c !== "" && isLedgerFile(c, at.dir, paths)));
	return !w.opaque && w.text !== "" && isLedgerFile(w.text, at.dir, paths);
}

/**
 * Does a write target name the ledger? wordNamesLedger, and after a `cd` the gate could not follow
 * (`cd "$DIR"`, a `cd` in one arm of a `case`) a relative path spelled with the ledger's own file
 * name or a sibling's, which the unknown directory may make the ledger. A word a `case` left with
 * several values is tested on each relative candidate: its `opaque` mark says the value is not one
 * known string, not that no candidate can be the ledger (PR #49 review round 2, N1:
 * `case a in a) f=ledger.db; cd /not-real;; esac; printf x > "$f"` was allowed). A word with an
 * unknown part is judged on its fragments (wordNamesLedger, item 102: `"$f$UNKNOWN"` there was
 * allowed); an opaque word with neither candidates nor fragments is not judged here.
 */
function writeNamesLedger(w: Word, e: Exec, paths: LedgerPaths): boolean {
	if (wordNamesLedger(w, e, paths)) return true;
	if (e.dirKnown) return false;
	const values = w.candidates ?? (w.opaque ? [] : [w.text]);
	return values.some((v) => {
		if (v === "" || v.startsWith("/")) return false;
		const name = basename(withoutSelector(v));
		return paths.files.some((f) => SIBLINGS.some((s) => name === basename(f) + s));
	});
}

/**
 * `sqlite3` dot-commands a ledger inspection may run: each only prints (sqlite.org/cli.html). Not
 * `.open` (it closes the read-only connection and reopens the file read-write: astra's control,
 * `sqlite3 -readonly /dev/null .databases '.open /dev/null' .databases` prints `r/o` then `r/w`),
 * nor `.shell`/`.system` (run a program), `.read` (more commands from a file), `.import`,
 * `.restore`, `.load` (an extension), or any other.
 */
const SQLITE_READ_DOT = /^\.(?:tables|schema|indexes|headers|mode|dump|databases|version|show|help|print|timer|width|nullvalue|changes)$/;
/**
 * Pragmas that only report: a table-describing pragma may name its table in parentheses; a bare
 * `user_version`/`schema_version` reads, and with a value in parentheses (`user_version(123)`) or
 * after `=` it sets (astra-5 R5-B2), so neither form is here.
 */
const SQLITE_READ_PRAGMA =
	/^PRAGMA\s+(?:(?:table_info|table_xinfo|foreign_key_list|index_list|index_info|index_xinfo)\s*(?:\(\s*[\w"'`[\]]+\s*\))?|user_version|schema_version)\s*$/i;
/**
 * Everything that may stand before `(` in a modeled read statement: SQLite's core read functions and
 * the keywords that take a parenthesis. `writefile()`, `readfile()`, `edit()` and
 * `load_extension()` are not here: `sqlite3 -readonly` does not stop them (live, sqlite 3.50.6:
 * `sqlite3 -readonly :memory: "SELECT writefile('/tmp/…','x')"` wrote the file).
 */
const SQLITE_READ_CALL: Record<string, true> = Object.fromEntries(
	(
		"count sum total min max avg group_concat string_agg length octet_length lower upper substr substring trim ltrim rtrim " +
		"replace instr coalesce ifnull nullif iif typeof abs round printf format quote hex unicode char like glob datetime date " +
		"time julianday strftime unixepoch json json_extract json_array json_object json_array_length json_type json_valid " +
		"json_each json_tree json_group_array json_group_object in exists as over filter cast using on values from join and or not " +
		"select where when then else case by having distinct all union intersect except is between"
	)
		.split(" ")
		.map((n) => [n, true]),
);

/** The statements of one SQL argument, split at `;` outside quotes; null when it has a comment or an unclosed quote. */
function sqlStatements(sql: string): string[] | null {
	const out: string[] = [];
	let cur = "";
	let quote = "";
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i]!;
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === "'" || c === '"' || c === "`" || c === "[") quote = c === "[" ? "]" : c;
		else if ((c === "-" && sql[i + 1] === "-") || (c === "/" && sql[i + 1] === "*")) return null;
		else if (c === ";") {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (quote) return null;
	out.push(cur.trim());
	return out.filter((s) => s !== "");
}

/** Why one SQL argument of a ledger inspection is not a modeled read, or null. */
function unreadSql(sql: string): string | null {
	const statements = sqlStatements(sql);
	if (statements === null) return `SQL with a comment or an unclosed quote (${sql.slice(0, 60)})`;
	if (statements.length === 0) return "an empty SQL argument";
	for (const s of statements) {
		const first = /^\w+/.exec(s)?.[0]?.toUpperCase();
		if (first === "PRAGMA") {
			if (!SQLITE_READ_PRAGMA.test(s)) return `a pragma outside the read set (${s.slice(0, 60)})`;
			continue;
		}
		if (first !== "SELECT" && first !== "WITH" && first !== "EXPLAIN") return `a statement that is not SELECT, WITH, EXPLAIN or a read pragma (${s.slice(0, 60)})`;
		// Names before `(` outside string literals: each a read function or keyword. A quoted
		// identifier (`"writefile"`, `[writefile]`, `` `writefile` ``) is still the function's name
		// (astra-5 R5-B2), so identifiers are unquoted and only single-quoted strings are erased.
		const unquoted = s
			.replace(/'(?:[^']|'')*'/g, "''")
			.replace(/"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]/g, (_m: string, dq?: string, bt?: string, br?: string) => (dq ?? bt ?? br ?? "").replace(/""/g, '"'));
		for (const m of unquoted.matchAll(/([A-Za-z_][\w$]*)\s*\(/g)) {
			if (!SQLITE_READ_CALL[m[1]!.toLowerCase()]) return `a call to ${m[1]}() in SQL, outside the read functions`;
		}
	}
	return null;
}

/**
 * Why a `sqlite3` command naming the ledger is not the one modeled inspection, or null (M4 fix
 * round 4, B4). Modeled exactly: `sqlite3 -readonly <literal ledger path>` and then one or more
 * literal arguments, each a dot-command from SQLITE_READ_DOT or SQL whose statements start with
 * SELECT, WITH, EXPLAIN or a read pragma and call only read functions. sqlite3 runs each argument
 * after the file as a command, in order, on the connection `-readonly` opened; with at least one it
 * reads nothing from stdin (live, sqlite 3.50.6: `echo .tables | sqlite3 /dev/null "SELECT 1"` printed
 * only `1`). A write statement that slips in (`WITH … DELETE`) meets that read-only connection,
 * which nothing in the modeled form can replace. Any other option (`-cmd`, `-init`, a second
 * `-readonly` after the file), a stdin redirect, a `file:` URI or a non-literal word refuses.
 */
function unmodeledSqlite(e: Exec, paths: LedgerPaths): string | null {
	const [, flag, db, ...commands] = e.argv;
	if (flag?.text !== "-readonly") return "sqlite3 on the ledger without `-readonly` as its first option";
	if (!db || db.opaque || db.expanded || db.glob || /^file:|\?/i.test(db.text)) return "sqlite3 -readonly with a database that is not the literal ledger path";
	const canon = canonicalOrLexical(resolve(e.dir, db.text));
	if (!paths.files.includes(canon) && !paths.files.includes(resolve(e.dir, db.text))) return `sqlite3 -readonly on ${db.text}, which is not the ledger file itself`;
	if (e.redirects.some((r) => r.op.includes("<"))) return "sqlite3 -readonly reading commands from a redirect";
	if (commands.length === 0) return "sqlite3 -readonly with no command arguments (it would read commands from stdin)";
	for (const w of commands) {
		if (w.opaque || w.expanded || w.glob) return "sqlite3 -readonly with a command argument that is not literal text";
		const t = w.text.trim();
		if (t.startsWith(".")) {
			if (/[\n;]/.test(t) || !SQLITE_READ_DOT.test(t.split(/\s+/)[0]!)) return `the dot-command \`${t.slice(0, 40)}\`, outside the read set`;
			continue;
		}
		if (t.startsWith("-")) return `the sqlite3 option \`${t}\` after the database`;
		const why = unreadSql(t);
		if (why) return why;
	}
	return null;
}

/** SQLite clients: each opens database files named in its arguments or in the SQL it runs. */
const SQLITE_CLIENTS: Record<string, true> = { sqlite3: true, "sqlite-utils": true, litecli: true, duckdb: true };
/**
 * SQL or dot-commands that reach a file other than the one named: `ATTACH` (whose file name is an
 * expression, `'/not-real/led' || 'ger.db'`), `.open`, `.restore`, `.backup`, `.clone`, `.save`,
 * `.read`, `.import`, `.shell`, `.system`, and the options that run commands (`-init`, `-cmd`).
 */
const SQLITE_REACHES_FILE = /\battach\b|(?:^|[\s;])\.(?:open|restore|backup|clone|save|read|import|shell|system|once|output|excel)\b|^-{1,2}(?:init|cmd)$/i;

/**
 * Why a SQLite client whose arguments do not name the ledger may still open it, or null: a
 * database word the gate cannot read (a glob compared as text, `sqlite3 /not-real/led*.db`; an
 * unknown value), a relative path after a `cd` to an unknown directory
 * (`cd "$LEDGER_DIR" && sqlite3 ledger.db`), an `ATTACH`/`.open` that names another file by
 * expression, or commands read from stdin that the gate does not see.
 */
function blindSqlite(e: Exec): string | null {
	const args = e.argv.slice(1);
	if (args.some((w) => w.opaque || w.glob)) return "a SQLite client with an argument the gate cannot read (a glob or an unknown value), which may name the ledger";
	if (!e.dirKnown && args.some((w) => !w.text.startsWith("-") && !w.text.startsWith("/"))) return "a SQLite client with a relative path after a cd to a directory the gate does not know";
	const reach = args.find((w) => SQLITE_REACHES_FILE.test(w.text.trim()));
	if (reach) return `a SQLite client running \`${reach.text.trim().slice(0, 40)}\`, which can open another file, the ledger included`;
	if (e.redirects.some((r) => r.op.includes("<")) || e.source.stdinFrom) return "a SQLite client reading commands from stdin, which the gate does not see and which may attach the ledger";
	return null;
}

/** A word as a refusal shows it: the values it may take (`one of a | b | head…tail`, a fragment's unknown middle as `…`), else its text. */
function valuesShown(w: Word): string {
	const values = [...(w.candidates ?? []), ...(w.fragments ?? []).map((f) => `${f.head}…${f.tail}`)];
	return values.length > 0 ? `one of ${values.join(" | ")}` : w.text;
}

/** Why one parsed command writes the ledger raw, or null. */
function rawWriteInExec(e: Exec, paths: LedgerPaths): string | null {
	for (const r of e.redirects) {
		if (r.op.includes(">") && r.target && writeNamesLedger(r.target, e, paths)) {
			// a target with an unknown part shows the values it may have, not its known text
			return `a shell redirect into the ledger file (${r.op} ${valuesShown(r.target)})`;
		}
	}
	const head = basename(e.argv[0]!.text);
	for (const w of writeDestinations(e)) {
		if (writeNamesLedger(w, e, paths)) return `\`${head}\` writing the ledger file (${e.argv.map((x) => x.text).join(" ")})`;
	}
	if (!e.argv.some((w) => wordNamesLedger(w, e, paths))) {
		const why = SQLITE_CLIENTS[head] ? blindSqlite(e) : null;
		return why ? `${why} (${e.argv.map((w) => w.text).join(" ")})` : null;
	}
	if (READ_ONLY_HEADS[head]) return null;
	if (head === "sqlite3") {
		const why = unmodeledSqlite(e, paths);
		return why ? `${why} (${e.argv.map((w) => w.text).join(" ")})` : null;
	}
	// The ledger module's own scripts may name the ledger: one program bun or node runs, no preload, no inline code.
	const runs = head === "bun" || head === "node" ? scriptRuns(head, e.argv.slice(1), e.dir, e.dirKnown) : [];
	const only = Array.isArray(runs) && runs.length === 1 && runs[0]!.main && runs[0]!.family !== "shell" ? runs[0]! : null;
	if (only && !only.word.opaque && (only.dirKnown || only.word.text.startsWith("/")) && canonicalOrLexical(resolve(only.dir, only.word.text)).startsWith(`${LEDGER_SCRIPTS}/`)) return null;
	return `\`${head}\` on the ledger file outside the ledger module (${e.argv.map((w) => w.text).join(" ")})`;
}

/**
 * bun's own subcommands (`bun --help`, bun 1.3.14): the word after `bun` (and its options) that names one is not a
 * script bun runs. `run`, `x` and `exec` are read on (scriptRuns). `bun test` is never read: test files open scratch
 * ledgers under the test preload, which `bunfig.toml` wires at this repository's root, module roots and test
 * directories only (ledger/test/isolate-preload.ts), so a `bun test` run from a directory under no such bunfig runs
 * its files with the real HOME, unread (a stated limit, migration/items/jo-only-boundary.md).
 */
const BUN_SUBCOMMANDS: Record<string, true> = Object.fromEntries(
	"test x repl exec install i add a remove rm update audit outdated link unlink publish patch patch-commit pm info why build init create c upgrade feedback completions help"
		.split(" ")
		.map((n) => [n, true]),
);
/** What bun and node try after a script path that names no file (`bun forge` runs `forge.ts`; live, bun 1.3.14 and node, 2026-10-19). */
const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** The most of one script the gate reads; a larger one is refused rather than read in part. */
const SCRIPT_CAP = 256 * 1024;
/** How deep a command line `bun exec` or `npx -c` runs is read into (each is a shell running another command line). */
const SHELL_RUN_DEPTH = 4;

/** The nearest directory holding `p` (the directory of `p`, then each above it) for which `test` holds, or null. */
function nearestDir(p: string, test: (dir: string) => boolean): string | null {
	for (let dir = dirname(p); ; dir = dirname(dir)) {
		if (test(dir)) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/**
 * Is `canonical` a tracked script of an agent-system-2.0 checkout: a file under a `scripts` directory anywhere in
 * it (`surface/scripts/`, `ledger/scripts/`, `skills/cross-model-review/references/panel/scripts/`, …) or under its
 * `bin/`? Why these run unread: lanes run them every day (`bun surface/scripts/invariants.ts`, `lane.ts`, the
 * cross-model-review panel's `panel.ts` that skills/cross-model-review/SKILL.md has a lane run), several load the
 * ledger module by design, and their text is the checkout's reviewed code, not code a model wrote this session.
 * The root is the nearest directory holding `ledger/schema.sql` and a `.git` (a checkout or a lane worktree, whose
 * `.git` is a file). A file a model places there by hand in a checkout or lane worktree is a deliberate act, beyond
 * the accident grade, and shows in that worktree's diff. A scratch clone of the repository has the same shape, so its
 * scripts run unread too, and a model may edit a scratch clone: that is a stated limit (migration/items/
 * jo-only-boundary.md). Reaching machinery stamps through these scripts (`lane.ts run`, `ctx-index --by`, the tick
 * scripts) is G7, the follow-up.
 */
function repoScript(canonical: string): boolean {
	const root = nearestDir(canonical, (dir) => existsSync(join(dir, "ledger", "schema.sql")) && existsSync(join(dir, ".git")));
	if (root === null) return false;
	const parts = canonical.slice(root.length + 1).split("/");
	return (parts[0] === "bin" && parts.length > 1) || parts.slice(0, -1).includes("scripts");
}

/** The file an interpreter runs for `path`: the path itself, else (bun and node) with an extension or a directory's index file; null if none. */
function scriptFile(path: string, js: boolean): string | null {
	const candidates = js ? [path, ...SCRIPT_EXTENSIONS.map((x) => path + x), ...SCRIPT_EXTENSIONS.map((x) => join(path, `index${x}`))] : [path];
	return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/**
 * The program text a command in this call writes into the script before it runs (a heredoc or herestring into
 * `cat > f`/`tee f`, an `echo`/`printf` redirected to it), or null when a writer's text cannot be read (`cp`,
 * `curl -o`, a pipe). Empty when nothing in the call writes it.
 */
function writtenScript(x: Expansion, path: string, js: boolean): string[] | null {
	const names = new Set([path, ...(js ? SCRIPT_EXTENSIONS.map((ext) => path + ext) : [])]);
	const texts: string[] = [];
	for (const e of x.commands) {
		if (!writeDestinations(e).some((w) => !w.opaque && names.has(resolve(e.dir, w.text)))) continue;
		const bodies = e.redirects.flatMap((r) => (r.body !== null ? [r.body] : []));
		const head = basename(e.argv[0]!.text);
		if (head === "echo" || head === "printf") bodies.push(e.argv.slice(1).map((w) => w.text).join(" "));
		if (bodies.length === 0) return null;
		texts.push(...bodies);
	}
	return texts;
}

/** A file a command runs as a program or loads before it, or a command line it hands to a shell (G1). */
interface ScriptRun {
	/** The command as a refusal names it (`bun`, `bun run`, `python3`, `bunx tsx`, `bun exec`). */
	via: string;
	/** The word naming the file, or the command line for `shell`. */
	word: Word;
	/** The directory a relative word resolves against, and whether it is known (a `cd` the gate could not follow). */
	dir: string;
	dirKnown: boolean;
	/** The code family the file is judged as; `shell` for the command line `bun exec` or `npx -c` runs. */
	family: CodeFamily | "shell";
	/** The program itself, not a module an option (`--preload`, `-r`, `--import`) loads before it. */
	main: boolean;
}

/** What `bun x`, `bunx` and npx may run on a file the gate then reads: the TypeScript runners and the two runtimes. */
const FILE_RUNNERS: Record<string, true> = { tsx: true, "ts-node": true, "ts-node-esm": true, node: true, bun: true };
/** bunx's and npx's options that take the next word (`bunx --help`, bun 1.3.14; `npm help exec`): the package to install. */
const PACKAGE_RUNNER_VALUE = /^(?:-p|--package)$/;

const opaqueWord = (w: Word): boolean => w.opaque || w.glob === true;

/**
 * The files a command runs as programs, the modules its options load first, and the command lines it hands to a
 * shell, or why the gate cannot name them (an option or a program word not known until it runs). Options are read
 * by exec.ts interpreterArgs: an unknown one is a flag with no value. Read: bun and node (and tsx, ts-node) after
 * their options, `bun run`, bun's `--cwd` and ruby's `-C`, every `--preload`/`-r`/`--require`/`--import`/`--loader`
 * module, `bun exec`'s and `npx -c`'s command line, `bun x`/`bunx`/npx running a FILE_RUNNERS name, and python,
 * perl, ruby and deno (`deno run|serve|watch <file>`, `deno <file>`). None for bun's other subcommands (`bun test`
 * included), deno's other subcommands, python `-m`, php and osascript.
 */
function scriptRuns(head: string, args: Word[], dir: string, dirKnown: boolean): ScriptRun[] | string {
	if (head === "bunx" || head === "npx") return packageRuns(head, args, dir, dirKnown);
	const family = head === "bun" || head === "node" || !Object.hasOwn(FILE_RUNNERS, head) ? interpreterFamily(head) : "js";
	if (family === null || family === "php" || family === "osascript") return [];
	const cannot = `\`${head}\` with an option or a program path not known until it runs`;
	const a = interpreterArgs(family, head, args);
	if (a.unknown) return cannot;
	const loads = [...a.loads];
	let cwd = a.cwd;
	let rest = a.operand < 0 ? [] : args.slice(a.operand);
	let via = head;
	// bun's subcommand, when the first operand names one: `run` is read on, `x` and `exec` below, the others run no file read here.
	const sub = head === "bun" ? rest[0]?.text : undefined;
	if (sub === "run") {
		const r = interpreterArgs("js", head, rest.slice(1));
		if (r.unknown) return cannot;
		loads.push(...r.loads);
		cwd = r.cwd ?? cwd;
		rest = r.operand < 0 ? [] : rest.slice(1 + r.operand);
		via = "bun run";
	} else if (sub !== undefined && Object.hasOwn(BUN_SUBCOMMANDS, sub)) rest = [];
	let at = dir;
	let known = dirKnown;
	if (cwd) {
		if (opaqueWord(cwd)) return `\`${via}\` with a working directory not known until it runs`;
		at = resolve(dir, cwd.text);
		known = dirKnown || cwd.text.startsWith("/");
	}
	const runs: ScriptRun[] = loads.map((word) => ({ via, word, dir: at, dirKnown: known, family, main: false }));
	if (sub === "x") {
		const more = packageRuns("bun x", args.slice(a.operand + 1), at, known);
		return typeof more === "string" ? more : [...runs, ...more];
	}
	if (sub === "exec") {
		const line = args[a.operand + 1];
		return line ? [...runs, { via: "bun exec", word: line, dir: at, dirKnown: known, family: "shell", main: true }] : runs;
	}
	if (rest[0]) runs.push({ via, word: rest[0], dir: at, dirKnown: known, family, main: true });
	return runs;
}

/** What `bunx`, `bun x` or npx runs (scriptRuns): a FILE_RUNNERS name on its file, or npx `-c`'s command line; none for any other package. */
function packageRuns(via: string, args: Word[], dir: string, dirKnown: boolean): ScriptRun[] | string {
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		if (opaqueWord(w)) return `\`${via}\` with a package or an option not known until it runs`;
		const t = w.text;
		if (via === "npx" && (t === "-c" || t === "--call" || t.startsWith("--call="))) {
			const line = t.startsWith("--call=") ? { text: t.slice("--call=".length), opaque: false } : args[i + 1];
			return line ? [{ via: "npx -c", word: line, dir, dirKnown, family: "shell", main: true }] : [];
		}
		if (PACKAGE_RUNNER_VALUE.test(t)) {
			i++;
			continue;
		}
		if (t.startsWith("-")) continue;
		// `tsx@4` and `@scope/name@1` name the package without the version.
		const pkg = t.replace(/(?!^)@[^/]*$/, "");
		if (!Object.hasOwn(FILE_RUNNERS, pkg)) return [];
		const runs = scriptRuns(pkg, args.slice(i + 1), dir, dirKnown);
		return typeof runs === "string" ? runs : runs.map((r) => ({ ...r, via: `${via} ${r.via}` }));
	}
	return [];
}

/** The bash call's own environment as the shell sees it: the session's, with the bash tool's `env` input over it (string values only). */
function callEnv(env: Record<string, string | undefined>, toolEnv: unknown): Record<string, string | undefined> {
	if (!toolEnv || typeof toolEnv !== "object") return env;
	const out = { ...env };
	for (const [name, value] of Object.entries(toolEnv)) if (typeof value === "string") out[name] = value;
	return out;
}

/**
 * Why a command's programs cross the Jo-only boundary, or null (G1). Each file scriptRuns names is read at gate
 * time with what this same call writes into it, and judged as eval code is (rawWriteInCode, in the interpreter's
 * family): it may not load the ledger module, name a `ledger.db` in an open or write, open a database under
 * `.agent-system-2/`, or, outside every git repository (a scratch script), load a module by a computed specifier.
 * A program word with an expansion is read at the value the session's environment gives it (`"$AS2_SCRATCH/f.ts"`,
 * `~/f.ts`); one the gate cannot resolve (a substitution, an unset variable) is refused. A script that cannot be
 * read is refused: over SCRIPT_CAP, unreadable, or written in this call from text the gate does not see (`cp`,
 * `curl -o`). A script that is missing and that no command in this call is seen to write runs nothing (the
 * interpreter fails on it), so it passes; one written by a writer the gate does not parse (a compiler's output, an
 * unzip) is beyond the accident grade, as a transitive import is. A command line `bun exec` or `npx -c` runs is
 * judged as a bash call of its own (bashCrossing). Not read: `bun test`, bun's and deno's other subcommands, a bare
 * name that is no file (`bun run typecheck`, a package.json script, a preload's package name), the ledger module's
 * own scripts, and a checkout's tracked scripts (repoScript), unless this call writes into them.
 */
function scriptCrossing(e: Exec, x: Expansion, paths: LedgerPaths, env: Record<string, string | undefined>, depth: number): string | null {
	const runs = scriptRuns(basename(e.argv[0]!.text), e.argv.slice(1), e.dir, e.dirKnown);
	if (typeof runs === "string") return `${runs}, so the gate cannot read what it runs; name the script by a literal path or a variable the session sets`;
	for (const run of runs) {
		const why = run.family === "shell" ? shellRunCrossing(run, paths, env, depth) : scriptFileCrossing(run, run.family, x, paths);
		if (why) return why;
	}
	return null;
}

/** Why the command line `bun exec` or `npx -c` runs crosses the boundary: it is judged as a bash call of its own, from the same directory. */
function shellRunCrossing(run: ScriptRun, paths: LedgerPaths, env: Record<string, string | undefined>, depth: number): string | null {
	if (opaqueWord(run.word)) return `\`${run.via}\` running a command line not known until it runs, so the gate cannot read it`;
	if (!run.dirKnown) return `\`${run.via}\` after a \`cd\` the gate could not follow, so the gate cannot read what it runs`;
	if (depth >= SHELL_RUN_DEPTH) return `\`${run.via}\` nested more than ${SHELL_RUN_DEPTH} command lines deep, which the gate does not read`;
	const why = bashCrossing(run.word.text, run.dir, env, undefined, paths, depth + 1);
	return why ? `\`${run.via}\` running \`${run.word.text}\`: ${why}` : null;
}

/** Why one file scriptRuns names crosses the boundary, or null (scriptCrossing). */
function scriptFileCrossing(run: ScriptRun, family: CodeFamily, x: Expansion, paths: LedgerPaths): string | null {
	const { word } = run;
	const lead = `\`${run.via}\` ${run.main ? "running" : "preloading"}`;
	if (opaqueWord(word)) return `${lead} ${valuesShown(word)}, a path not known until it runs, so the gate cannot read the script; name it by a literal path or a variable the session sets`;
	const js = family === "js";
	// A bare name (no `/`, no `.`) that is no file is, for bun and node, a package.json script, a bin or a preload's package: what runs is not this word's text.
	const bare = js && !/[./]/.test(word.text);
	if (!run.dirKnown && !word.text.startsWith("/")) {
		return bare ? null : `${lead} ${word.text} after a \`cd\` the gate could not follow, so it cannot read the script; run it by its absolute path`;
	}
	const path = resolve(run.dir, word.text);
	const written = writtenScript(x, path, js);
	if (written === null) return `${lead} ${path}, which this same call writes from text the gate cannot read`;
	const file = scriptFile(path, js);
	if (!file && written.length === 0) return null;
	const texts = [...written];
	const canonical = file ? canonicalOrLexical(file) : null;
	if (canonical && !canonical.startsWith(`${LEDGER_SCRIPTS}/`) && !repoScript(canonical)) {
		let size: number;
		try {
			size = statSync(canonical).size;
			if (size <= SCRIPT_CAP) texts.push(readFileSync(canonical, "utf8"));
		} catch (err) {
			return `${lead} ${canonical}, which the gate cannot read (${err instanceof Error ? err.message : String(err)})`;
		}
		if (size > SCRIPT_CAP) return `${lead} ${canonical}, ${size} bytes, over the ${SCRIPT_CAP / 1024} KiB the gate reads of a script`;
	}
	// A computed import() in a script inside a git repository or worktree (a `.git` at or above it) is that
	// repository's code (another product's build script, `await import(path)`), not a scratch script a model
	// wrote: refused only outside every repository (G1 review round 1).
	const computedLoads = nearestDir(canonical ?? path, (dir) => existsSync(join(dir, ".git"))) === null;
	for (const text of texts) {
		const why = rawWriteInCode(text, paths, dirname(path), family, computedLoads);
		if (why) return `${lead} ${canonical ?? path}: ${why}`;
	}
	return null;
}

/**
 * The open family, with its receiver chain: builtin `open`, `os.open`, `io.open`, `fs.open`,
 * `fs.openSync`, `fs.promises.open`, `Path(p).open`, `codecs.open`, `io.FileIO`, `os.fdopen`. Read on
 * the masked code, so a name inside a literal is not a match (it is caught as a literal instead).
 */
const OPEN_NAME = /(?<![\w$])((?:[\w$]+\s*\.\s*)*)(open\w*|fdopen|FileIO)(?![\w$])/g;
/** A literal naming an open-family API or the receiver/constant of the named read-only flag: the code reaches it by name (`fs["open"]`, `getattr(os, "open")`, `sys.modules["os"]`). */
const REFLECTED_NAME = /^(?:open\w*|fdopen|FileIO|os|O_RDONLY)$/;
/** Ways code rebinds or reaches a name through a string, which the gate cannot follow. */
const REFLECTION = /(?<![\w$.])(?:exec|eval|compile|setattr|delattr|globals|locals|vars|__builtins__|__dict__|Reflect|defineProperty|Function)\b|\bsys\s*\.\s*modules\b/;
/**
 * A mode argument that proves an open reads only (M4 fix round 4, B2): the string modes `r`, `rb`
 * and `rt`, bare or as `mode=`/`flags=`. Sources, fetched 2026-09-29:
 * - Node, https://nodejs.org/api/fs.html#file-system-flags: `'r'` "Open file for reading"; every
 *   other flag string writes, appends, creates or (`'rs'`, `'rs+'`) is outside this set — `'as'`,
 *   `'as+'` append and `'rs+'` opens "for reading and writing" (astra R4-B2, triad #3).
 * - Python, https://docs.python.org/3/library/functions.html#open: `'r'` reading (the default), `'b'`
 *   binary, `'t'` text; `'w'`, `'x'`, `'a'` and `'+'` write.
 * Numeric flags are over-approximated as writable on purpose (triad, Kimi): a number is O_* bits
 * the gate would have to decode per platform (1 is O_WRONLY on Linux and macOS), so every number
 * refuses, as does any computed value.
 */
const READ_ONLY_MODE = /^(?:(?:mode|flags)\s*=\s*)?(["'`])(?:r|rb|rt)\1$/;
/** Python's text options, which never change what an open may do to the file. */
const TEXT_OPTION = /^(?:encoding|errors|newline)\s*=/;

/** An assignment operator (`=`, `+=`, `:=`, …), not a comparison. */
const ASSIGN = /(?<![=!<>])(?:[-+*/%&|^@:]|<<|>>|\/\/|\*\*)?=(?!=)/;

/**
 * The statement of `code` around `at`: from the last top-level `;` or newline before it to the next
 * after it. Bracket depth is tracked, so a call spanning lines is one statement.
 */
function statementAt(code: string, at: number): { before: string; after: string } {
	let start = 0;
	let depth = 0;
	for (let i = 0; i < at; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
		else if ((c === ";" || c === "\n") && depth === 0) start = i + 1;
	}
	let end = code.length;
	for (let i = at; i < code.length; i++) {
		const c = code[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
		else if ((c === ";" || c === "\n") && depth === 0) {
			end = i;
			break;
		}
	}
	return { before: code.slice(start, at), after: code.slice(at, end) };
}

/**
 * Is `os.O_RDONLY` in this code the read-only flag (M4 fix round 4, B3)? Modeled only for Python's
 * `os`, bound by a plain `import os`, in code that never rebinds it: every `os` is the target of an
 * `import` without `as`/`from`, or an attribute read `os.<name>` in a statement with no assignment
 * after it and no `del`/`for`/`as`/`global`/`nonlocal` before it; every `O_RDONLY` is spelled
 * `os.O_RDONLY`; no literal names `os` or `O_RDONLY`; no reflection (REFLECTION). That keeps
 * `import os; os.open(p, os.O_RDONLY)` and refuses `os.O_RDONLY = 1`, `import posix as os`,
 * `setattr(os, …)`, `del os.O_RDONLY`, `for os.O_RDONLY in …` and `(a, os.O_RDONLY) = …`. The rule
 * refuses some harmless code too (`print(os.O_RDONLY, sep="")`): it is fail-closed by design.
 */
function readOnlyConstant(facts: CodeFacts): boolean {
	const m = facts.masked;
	if (REFLECTION.test(m) || facts.literals.some((l) => l === "os" || l === "O_RDONLY")) return false;
	for (const o of m.matchAll(/(?<![\w$])O_RDONLY(?![\w$])/g)) {
		if (!/(?<![\w$.])os\s*\.\s*$/.test(m.slice(0, o.index))) return false;
	}
	for (const o of m.matchAll(/(?<![\w$.])os(?![\w$])/g)) {
		const { before, after } = statementAt(m, o.index!);
		if (/^\s*import\s+[\w.]+(?:\s*,\s*[\w.]+)*\s*$/.test(before + after) && !/\bas\b/.test(before + after)) continue;
		if (!/^os\s*\.\s*[\w$]+/.test(after)) return false;
		// A keyword argument (`os.open(p, flags=os.O_RDONLY)`) names a parameter; it rebinds nothing.
		if (ASSIGN.test(after.slice(2).replace(/([(,]\s*)[A-Za-z_]\w*\s*=(?!=)/g, "$1")) || /\b(?:del|for|as|global|nonlocal|lambda|def|class)\b/.test(before)) return false;
	}
	return true;
}

/** A call's top-level arguments as spans of `folded`, split on `masked` (same positions); null if unbalanced. */
function argTexts(facts: CodeFacts, open: number): string[] | null {
	const inner = callArgs(facts.masked, open);
	if (inner === null) return null;
	const out: string[] = [];
	let depth = 0;
	let from = open + 1;
	for (let i = open + 1; i <= open + inner.length; i++) {
		const c = facts.masked[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			out.push(facts.folded.slice(from, i).trim());
			from = i + 1;
		}
	}
	out.push(facts.folded.slice(from, open + 1 + inner.length).trim());
	return out.filter((a) => a !== "");
}

/** A trailing callback argument (`fs.open(p, "r", () => {})`): where the call reports, not how it opens. */
const CALLBACK = /^(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*=>|^(?:async\s+)?function\b/;

/**
 * Why an open in the code could write, or null (M4 fix round 4, B2: typed argument capture replaces
 * erase-and-rescan). Every open-family name must be called where it is named (`f = os.open`,
 * `{ openSync: o } = fs` and `fs["open"]` hide which open runs and with what, so they refuse), and
 * each call's arguments after the path — or all of them for a method on a call result
 * (`Path(p).open("w")`) — must each be a READ_ONLY_MODE literal, a TEXT_OPTION, or `os.O_RDONLY`
 * where readOnlyConstant holds; a last argument may be a callback. No mode at all is a read (both
 * defaults are `r`). `Ledger.open(…)` gets no pass: code may not load the ledger module (the Jo-only
 * boundary), so a `Ledger` here is some other open (`import os as Ledger` is `os`, adversarial-1).
 */
function writingOpen(facts: CodeFacts): string | null {
	const reflected = facts.literals.find((l) => REFLECTED_NAME.test(l) && l !== "os" && l !== "O_RDONLY");
	if (reflected !== undefined) return `a literal naming the open API "${reflected}" (an open reached by name)`;
	if (REFLECTION.test(facts.masked)) return "reflection (exec, eval, setattr, globals, …) that can rebind the open the code calls";
	for (const m of facts.masked.matchAll(OPEN_NAME)) {
		const after = m.index! + m[0].length;
		const paren = /^\s*\(/.exec(facts.masked.slice(after));
		if (!paren) return `\`${m[0].trim()}\` named without being called (an alias hides which open runs and how)`;
		const args = argTexts(facts, after + paren[0].length - 1);
		if (args === null) return `an ${m[0].trim()}(…) the gate could not read to its end`;
		// `Path(p).open("w")` is a method on a call result, whose every argument is a mode;
		// `require("fs").openSync(p, "r")` is the module's function, whose first argument is the path.
		const receiver = facts.masked.slice(0, m.index!);
		const method = m[1] === "" && receiver.endsWith(".") && !/(?<![\w$])(?:require|import)\s*\([^()]*\)\s*\.\s*$/.test(receiver);
		const modes = method ? args : args.slice(1);
		for (const [i, a] of modes.entries()) {
			if (READ_ONLY_MODE.test(a) || TEXT_OPTION.test(a)) continue;
			if (i === modes.length - 1 && i > 0 && CALLBACK.test(a)) continue;
			if (/^(?:flags\s*=\s*)?os\s*\.\s*O_RDONLY$/.test(a) && readOnlyConstant(facts)) continue;
			return `an ${m[0].trim()}(…) whose mode or flags are not a literal read-only mode (${a.slice(0, 60)})`;
		}
	}
	return null;
}

/** SQLite (and other database) modules, as a module specifier: an import, `__import__`, `import()`, `require`. */
const DB_MODULE = /^(?:sqlite3|bun:sqlite|node:sqlite|better-sqlite3|sqlite|apsw|sqlalchemy|peewee|dataset|duckdb)$/;
/** Python's statement imports, whose module is a bare identifier, not a literal (`import apsw`, `from sqlite3 import connect`). */
const PY_IMPORT = /(?:^|[\n;])\s*(?:import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)|from\s+([\w.]+)\s+import\b)/g;
/** Module acquisition the gate cannot resolve to a name: a computed `import()`, `require`, `__import__` or `importlib`. */
const COMPUTED_IMPORT = /\b(?:__import__|import_module|require|import)\s*\(\s*(?!["'`][^"'`]*["'`]\s*\))/;
/** The constructor and open names database modules export (`new Database(p)`, `new sqlite.DatabaseSync(p)`, `sqlite3.connect(p)`, `apsw.Connection(p)`, `create_engine(url)`). */
const DB_NAMES = ["Database", "DatabaseSync", "connect", "Connection", "create_engine"];
const JS_IMPORT = /\bimport\s*(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([\w$]+))?\s*from\b/g;
const JS_REQUIRE = /\b(?:const|let|var)\s+(?:\{([^}]*)\}|([\w$]+))\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g;
const PY_FROM = /(?:^|[\n;])[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]*(?:\(([^)]*)\)|([\w \t,]+))/g;
const PY_AS = /(?:^|[\n;])[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/g;

/**
 * The names code binds imports to, and the code with those declarations blanked (same length):
 * `import {Database as D} from …` → D, `import D from …`, `import * as S from …`,
 * `const {Database: D} = require(…)` or `= await import(…)`, `const S = require(…)`, Python
 * `from sqlite3 import connect as c` and `import sqlite3 as s` (astra-6 B9: an aliased constructor
 * was not an open the gate saw).
 */
function importBindings(masked: string): { names: string[]; rest: string } {
	const names: string[] = [];
	const last = (s: string, sep: RegExp) => s.split(sep).at(-1)!.trim();
	const list = (s: string | undefined, sep: RegExp) => {
		for (const piece of (s ?? "").split(",")) {
			const n = last(piece, sep);
			if (/^[\w$]+$/.test(n)) names.push(n);
		}
	};
	let rest = masked;
	const blank = (re: RegExp, take: (m: RegExpMatchArray) => void) => {
		rest = rest.replace(re, (...a) => {
			take(a as unknown as RegExpMatchArray);
			return " ".repeat((a[0] as string).length);
		});
	};
	blank(JS_IMPORT, (m) => {
		list(m[1], /\s+as\s+/);
		list(m[2], /\s+as\s+/);
		list(m[3], /\s+as\s+/);
	});
	blank(JS_REQUIRE, (m) => {
		list(m[1], /:/);
		list(m[2], /:/);
	});
	blank(PY_FROM, (m) => list(m[1] ?? m[2], /\s+as\s+/));
	blank(PY_AS, (m) => list(m[1]?.replace(/\.[\w.]*/g, ""), /\s+as\s+/));
	return { names, rest };
}

const escapeRe = (s: string) => s.replace(/[$]/g, "\\$");

/**
 * Why code that loads a database module (and names no ledger) may open the ledger, or null: every open
 * through an export or a bound name must have a literal target, and neither may be named without
 * being called (`const X = D; new X(p)` hides which open runs). A module loaded with no open the gate
 * can find is refused too: it cannot say which call opens a database (astra-6 B9).
 */
function dbOpenVerdict(facts: CodeFacts, module: string): string | null {
	const { names, rest } = importBindings(facts.uncommented);
	const derived = dbConstructorEscape(facts, [...DB_NAMES, ...names]);
	if (derived) return `eval code loading the database module "${module}" and ${derived}`;
	const all = [...new Set([...DB_NAMES, ...names])].map(escapeRe);
	const open = new RegExp(String.raw`(?<![\w$])(?:new\s+)?(?:[\w$]+\s*\.\s*)*(?:${all.join("|")})\s*\(`, "g");
	let opens = 0;
	for (const m of rest.matchAll(open)) {
		opens++;
		const args = argTexts(facts, m.index! + m[0].length - 1);
		const target = args?.[0];
		if (target === undefined || !PLAIN_LITERAL.test(target)) {
			return `eval code loading the database module "${module}" and opening a database whose target is computed at run time (${m[0].trim()}${(target ?? "").slice(0, 40)}…), which may be the ledger`;
		}
	}
	for (const n of DB_NAMES) {
		for (const m of rest.matchAll(new RegExp(String.raw`(?<![\w$])${n}(?![\w$])(?!\s*\()`, "g"))) {
			return `eval code loading the database module "${module}" and naming \`${n}\` without calling it (an alias hides which database opens) at ${rest.slice(m.index!, m.index! + 40).trim()}`;
		}
	}
	for (const n of names) {
		for (const m of rest.matchAll(new RegExp(String.raw`(?<![\w$.])${escapeRe(n)}(?![\w$])(?!\s*[(.])`, "g"))) {
			return `eval code loading the database module "${module}" and naming the import \`${n}\` without calling it (an alias hides which database opens) at ${rest.slice(m.index!, m.index! + 40).trim()}`;
		}
	}
	return opens === 0 ? `eval code loading the database module "${module}" with no open the gate can find (it cannot tell which call opens a database, or on what)` : null;
}
/** A string literal with no interpolation: a target the gate can read. */
const PLAIN_LITERAL = /^(?:(["'])[^"'\\]*\1|`[^`$\\]*`)$/;

/** The database module this code loads, by specifier literal or Python statement import; null if none. */
function dbModule(facts: CodeFacts): string | null {
	const literal = facts.literals.find((l) => DB_MODULE.test(l));
	if (literal) return literal;
	for (const m of facts.masked.matchAll(PY_IMPORT)) {
		const names = m[1] ? m[1].split(",").map((n) => n.trim().split(/\s+/)[0]!) : [m[2]!];
		const hit = names.find((n) => DB_MODULE.test(n.split(".")[0]!));
		if (hit) return hit;
	}
	return null;
}

/** The ledger's default file name and root, as DEFAULT_LEDGER_RELATIVE spells them: a `ledger.db` anywhere is a ledger to the boundary. */
const LEDGER_FILE = basename(DEFAULT_LEDGER_RELATIVE);
const LEDGER_ROOT = new RegExp(String.raw`(?:^|[/"'\x60])${dirname(DEFAULT_LEDGER_RELATIVE).replaceAll(".", "\\.")}(?:/|$|["'\x60])`);
/** A word or literal naming a `ledger.db` (or one of its siblings) by its last component. */
const namesLedgerFile = (text: string) => SIBLINGS.some((s) => basename(text) === LEDGER_FILE + s);

/**
 * Why eval code, inline `bun -e` code, or a script an interpreter runs (scriptCrossing) crosses the Jo-only
 * boundary or writes the ledger raw, or null.
 * Code may not load the ledger module (`ledger/src`, by import, dynamic import or require), load any module
 * by a specifier computed at run time (JS: eval-code.ts computedModuleLoad, G1; only where `computedLoads` holds:
 * eval, inline code and scripts outside every git repository), nor set,
 * unset or override a boundary name in the environment (eval-code.ts boundaryEnvWrite). Code names
 * the ledger when it carries its path (constant concatenations folded), its file name or any
 * `ledger.db`, the env var, or any literal path that canonicalizes (the direct-write realpath
 * check) to the ledger or a sibling (R3-B5). Such code may read bytes with a literal read-only open
 * (writingOpen); any file-write, database module (typed before literal erasure, so
 * `__import__("sqlite3")`, `import("bun:sqlite")` and a bare `import apsw` count, R3-B4), computed
 * import, process API, or open that is not provably read-only refuses it. No database module is
 * modeled on the ledger, whatever its options: `readonly: true` is refused like any other handle
 * (M4 fix round 4, B5, Plumb's ruling; the constructor's options are not read at all). Code that
 * does not name the ledger but loads a database module and names `.agent-system-2/`, or opens a
 * database whose target is computed at run time, refuses too: the target may be the ledger
 * (`new Database([…].join("/"))`, adversarial-1).
 */
function rawWriteInCode(code: string, paths: LedgerPaths, dir: string, family: CodeFamily | undefined, computedLoads = true): string | null {
	const facts = codeFacts(code, family);
	const spec = ledgerModuleImport(facts);
	if (spec) return `code loading the ledger module ("${spec}"); eval, inline code and the scripts an agent runs never load it`;
	const load = family === "js" && computedLoads ? computedModuleLoad(facts) : null;
	if (load) return `code loading a module whose specifier is computed at run time (${load}), which may be the ledger module; an import() or require() takes one literal string`;
	const env = boundaryEnvWrite(facts);
	if (env) return env;
	const file = basename(paths.files[0]!);
	const names =
		paths.needles.some((n) => facts.folded.includes(n)) ||
		facts.literals.some(
			(l) =>
				namesLedgerFile(l) ||
				SIBLINGS.some((s) => l.endsWith(file + s)) ||
				paths.files.some((f) => l.startsWith(dirname(f)) && l.includes(file)) ||
				(l !== "" && !l.includes("\n") && l.length < 4096 && /^[~./\w]/.test(l) && isLedgerFile(l.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"), dir, paths)),
		);
	const module = dbModule(facts);
	if (!names && module && LEDGER_ROOT.test(facts.folded)) return `eval code loading the database module "${module}" and naming a path under ${dirname(DEFAULT_LEDGER_RELATIVE)}/, the ledger's root`;
	if (!names) return module ? dbOpenVerdict(facts, module) : null;
	if (module) return `eval code naming the ledger file and loading the database module "${module}" (no in-process database handle to the ledger is modeled, \`readonly: true\` included)`;
	const computed = COMPUTED_IMPORT.exec(facts.folded);
	if (computed) return `eval code naming the ledger file and loading a module the gate cannot name (${computed[0].trim()}…)`;
	const member = computedMember(facts);
	if (member) return `eval code naming the ledger file and reaching a member computed at run time (${member.slice(0, 60)}), whose method the gate cannot name`;
	const api = WRITE_API.exec(facts.bare) ?? SPAWN_API.exec(facts.bare) ?? /\.\s*write_(?:text|bytes)\s*\(/.exec(facts.bare);
	if (api) return `eval code naming the ledger file and calling ${api[0].trim()} (only ledger/src/index.ts writes it)`;
	// A `Bun.file()` handle writes through any alias (`const f = Bun.file(p); f.writer()`, astra-5
	// R5-B3): with one in the code, every write/delete spelling refuses, bound or not.
	const bunWrite = /\bBun\s*\.\s*file\s*\(/.test(facts.bare) ? /(?<![\w$])(?:write\w*|delete|unlink)(?![\w$])/.exec(facts.bare) : null;
	if (bunWrite) return `eval code naming the ledger file with a Bun.file() handle and \`${bunWrite[0]}\` (only ledger/src/index.ts writes it)`;
	const open = writingOpen(facts);
	return open ? `eval code naming the ledger file with ${open} (only ledger/src/index.ts writes it)` : null;
}

function refuse(what: string): Refusal {
	return {
		block: true,
		reason:
			`P-11 row 10 refused this: ${what}. This is the ${BOUNDARY} (ledger/src/authority.ts, migration/items/jo-only-boundary.md): ` +
			`the ledger is written only by the ledger module in the processes Jo's machinery starts (the surface, the lane runner, a lane's ledger tools), ` +
			`never from eval, inline code or a script an agent runs with bun or node (a checkout's own surface/, ledger/, classifier/, gates/, install/ scripts and bin/ run unread); ` +
			`and no call may set, unset or override AGENT_SYSTEM_ROLE, AGENT_SYSTEM_LANE_ID, AGENT_SYSTEM_WORKLOAD_ID, ` +
			`AGENT_SYSTEM_LEDGER_DB or an AS2_TEST_* name (reading them is fine). The ledger's rules live in the file and its writer is the ledger module ` +
			`(ledger/src/index.ts, SPEC-2.0.md § B2); a raw write bypasses its provenance and would be refused by the file's triggers or corrupt WAL state. ` +
			`Write through your tools (a lane's lane_* tools, the orchestrator's orchestrator_* tools). ` +
			`To read the ledger, in bash run \`sqlite3 -readonly <literal ledger path>\` followed only by read dot-commands (.tables .schema .indexes .headers .mode .dump .databases .version .show .help .print .timer .width .nullvalue .changes) and SELECT / WITH / EXPLAIN / read-pragma SQL. ` +
			`Plain byte readers (cat, head, tail, wc, stat, hexdump, strings, cmp, diff, …) may name the ledger without a redirect into it. ` +
			`No in-process database handle to the ledger is modeled, \`readonly: true\` included. ` +
			`Raw bytes may be read in eval with a literal read-only open of the literal path: \`open(path, "rb")\`, or \`import os\` then \`os.open(path, os.O_RDONLY)\`. ` +
			`Run a test file with plain \`bun test <file>\`.`,
	};
}

/** Shell builtins that set, unset or export a variable named in their arguments. */
const ENV_BUILTINS: Record<string, true> = { unset: true, export: true, declare: true, typeset: true, local: true, readonly: true };

/** `env` flags (`-i`, `-iu`, `--ignore-environment`, a lone `-`) that start the command with an empty environment. */
function emptiesEnv(token: string): boolean {
	if (token === "-" || token === "--ignore-environment") return true;
	const flags = /^-([^-].*)$/.exec(token)?.[1];
	if (!flags) return false;
	const valueAt = flags.search(/[uCSP]/);
	return (valueAt < 0 ? flags : flags.slice(0, valueAt)).includes("i");
}

/** The names an `env` wrapper's words unset (`-u NAME`, `-uNAME`, `--unset NAME`, `--unset=NAME`). */
function envUnsets(words: readonly Word[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const t = words[i]!.text;
		const joined = /^(?:-[^-]*u|--unset=)(.+)$/.exec(t);
		if (joined) out.push(joined[1]!);
		else if (/^-[^-]*u$/.test(t) || t === "--unset") out.push(words[i + 1]?.text ?? "");
	}
	return out;
}

/**
 * Why a bash call crosses the Jo-only boundary in its environment, or null: it sets, unsets or
 * overrides a boundary name (a prefix or `env` assignment, `export`/`declare`/…, `unset`, `env -u`,
 * `env -i`, the bash tool's `env` input: all land in `assigned` or the commands), here or in a script
 * it runs. Reading a variable is not an assignment and passes. A call with a `sudo` or `doas` wrapper
 * is left to row 6, which refuses every such call and names the wrapper: what runs under it has
 * another user's environment anyway (as2test-refresh-pins).
 */
function boundaryEnvInShell(x: Expansion): string | null {
	if (x.commands.some((e) => e.mods.wrappers.some((w) => /^(?:sudo|doas)(?:\s|$)/.test(w)))) return null;
	for (const name of x.assigned.keys()) {
		if (boundaryEnvName(name)) return `a command that sets ${name} (a prefix or env assignment, export, or the bash tool's env input)`;
	}
	for (const e of x.commands) {
		const head = posix.basename(e.argv[0]?.text ?? "");
		if (Object.hasOwn(ENV_BUILTINS, head)) {
			const name = e.argv.slice(1).map((w) => w.text.split("=")[0]!).find((n) => !n.startsWith("-") && boundaryEnvName(n));
			if (name) return `\`${head} ${name}\``;
		}
		const env = e.mods.wrappers.filter((w) => w === "env" || w.startsWith("env "));
		if (env.some((w) => w.split(/\s+/).slice(1).some(emptiesEnv))) return `\`env -i\`, which starts the command without the agent-context tags`;
		if (env.length > 0) {
			const words = e.source?.words ?? [];
			const unset = envUnsets(words.slice(0, Math.max(0, words.length - e.argv.length))).find(boundaryEnvName);
			if (unset) return `\`env -u ${unset}\``;
		}
	}
	return null;
}

/** `sqlite3` without `-readonly` on a `ledger.db` (or a sibling) or a file under `.agent-system-2/`, wherever it sits, or null. */
function sqliteOnLedgerName(e: Exec): string | null {
	if (posix.basename(e.argv[0]?.text ?? "") !== "sqlite3" || e.argv.some((w) => w.text === "-readonly")) return null;
	const db = e.argv.slice(1).find((w) => !w.text.startsWith("-") && (namesLedgerFile(w.text) || LEDGER_ROOT.test(w.text)));
	return db ? `sqlite3 without -readonly on ${db.text}, a ledger file` : null;
}

/** The first environment-named write (astra-7 B3, astra-8 B2) that names the ledger, as a refusal reason. */
function envLedgerWrite(writes: Word[], dir: string, paths: LedgerPaths): string | null {
	const w = writes.find((x) => wordNamesLedger(x, { dir, dirKnown: true }, paths));
	return w ? `an interpreter told by its environment to write the ledger file (${w.text})` : null;
}

/**
 * Why a bash command line crosses the boundary or writes the ledger raw, or null. `sessionEnv` is the session's
 * environment and `toolEnv` the bash tool's `env` input: its string values are what `$NAME` expands to in the
 * command, over the session's (callEnv). `depth` counts the command lines `bun exec` and `npx -c` nest (shellRunCrossing).
 */
function bashCrossing(cmd: string, cwd: string, sessionEnv: Record<string, string | undefined>, toolEnv: unknown, paths: LedgerPaths, depth: number): string | null {
	const env = callEnv(sessionEnv, toolEnv);
	const x = expandShell(cmd, cwd, env, toolEnv);
	const crossing = boundaryEnvInShell(x);
	if (crossing) return crossing;
	for (const e of x.commands) {
		const why = rawWriteInExec(e, paths) ?? sqliteOnLedgerName(e) ?? scriptCrossing(e, x, paths, env, depth);
		if (why) return why;
		// git appends its trace to the file a GIT_TRACE* variable names (astra-6 B7).
		if (gitCall(e)) {
			for (const w of gitTraceFiles(x.assigned)) {
				if (w.opaque ? paths.needles.some((n) => w.text.includes(n)) : wordNamesLedger(w, e, paths)) return `git writing its trace into the ledger file (${w.text})`;
			}
		}
	}
	// An interpreter's environment can name a file it writes, whatever command follows (astra-7 B3:
	// NODE_OPTIONS=--redirect-warnings=<ledger>); row 6 refuses the forms interpreterEnv does not model.
	const sink = envLedgerWrite(interpreterEnv(x, cwd).writes, cwd, paths);
	if (sink) return sink;
	for (const c of x.code) {
		const why = rawWriteInCode(c.text, paths, c.dir, c.family);
		if (why) return `inline ${c.lang} code: ${why}`;
		const codeSink = envLedgerWrite(codeInterpreterEnv(c.text, c.family, c.dir, env).writes, c.dir, paths);
		if (codeSink) return codeSink;
	}
	// What the gate cannot see may name the ledger: refuse only when the command text does (row 6 refuses the rest).
	if (x.blind.length > 0 && paths.needles.some((n) => cmd.includes(n) || cmd.includes(basename(paths.files[0]!)))) {
		return `a command naming the ledger that the gate cannot read to the end (${x.blind[0]})`;
	}
	return null;
}

/** Row 10 over one tool call. */
export function checkRawLedgerWrite(call: ToolCall, ctx: CallContext): Refusal {
	const paths = ledgerPaths(ctx.env);
	if (call.toolName === "bash") {
		const cwd = typeof call.input.cwd === "string" ? resolve(ctx.cwd, call.input.cwd) : ctx.cwd;
		const why = bashCrossing(bashCommand(call.input), cwd, ctx.env, call.input.env, paths, 0);
		return why ? refuse(why) : null;
	}
	if (call.toolName === "eval") {
		// The eval tool's `language` picks the comment syntax (py: `#`, js: `//`, `/* */`); any other value blanks no comment.
		const lang = call.input.language;
		const family = lang === "py" || lang === "python" ? "python" : lang === "js" || lang === "ts" ? "js" : undefined;
		const code = String(call.input.code ?? call.input.cell ?? "");
		const why = rawWriteInCode(code, paths, ctx.cwd, family) ?? envLedgerWrite(codeInterpreterEnv(code, family, ctx.cwd, ctx.env).writes, ctx.cwd, paths);
		// The processes the code starts, with the environment it gives them (astra-8 B2), are judged by envLedgerWrite.
		const r = why ? refuse(why) : null;
		// Row 10 runs before row 6, so its refusal also carries row 6's eval rule (PLAN wl-muzs0ytnaet1v4 D1 (f)).
		if (r && evalProcessStart(codeFacts(code, family), family)) {
			return { block: true, reason: `${r.reason} This eval also starts a process: run the command with the bash tool, where the gate reads it; eval does not start processes.` };
		}
		return r;
	}
	for (const target of writeTargets(call, ctx.cwd)) {
		if (isLedgerFile(target, ctx.cwd, paths)) return refuse(`a ${call.toolName} to ${target}, the ledger file or its WAL/SHM/journal sibling`);
	}
	return null;
}
