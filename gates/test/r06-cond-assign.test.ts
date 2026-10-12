// MIGRATION.md item 101 regression tests (PLAN wl-mv4rzy6vmvjeo0, revision 8 § Tests and proof):
// conditional and subshell assignments are possible, not definite. Before the change the parser applied
// every assignment and `cd` in textual order, so `a=git; if false; then a=ls; fi; $a push origin main`
// was judged as `ls push origin main` and allowed, and `$( … )`, backticks, `<( … )` and `( … )` wrote
// into the parent's variables.
//
// Three kinds of case. A refusal case is tagged `new` (row 6 or row 10 allowed it on the base, so it is
// red there) or `kept` (already refused on the base, pinned so the change cannot lose it); the tag is in
// the test name. An allow control is green before and after. A parser-precision assertion may be red
// before and is green after. The file imports only what the base already exports (`checkReserved`,
// `checkRawLedgerWrite`, `parseShell`), so the fail-before run can take it to an archive of the base.
// Every probe is inert: the gate only reads the strings, and the ledger path does not exist.
import { describe, expect, test } from "bun:test";
import { checkReserved } from "../src/rows/r06-reserved";
import { checkRawLedgerWrite } from "../src/rows/r10-raw-ledger";
import { parseShell } from "../src/shell-parse";
import type { CallContext } from "../src/types";

const env = { HOME: "/nonexistent-home", AGENT_SYSTEM_LEDGER_DB: "/not-real/ledger.db" };

interface Refusal {
	name: string;
	tag: "new" | "kept";
	/** The row that must refuse: 6 (reserved, or blind on an opaque head) or 10 (a write to the ledger). */
	row: 6 | 10;
	command: string;
	/** The call's working directory; `/not-real` puts a relative `ledger.db` on the ledger. */
	cwd?: string;
	/** Extra session environment. */
	extra?: Record<string, string>;
}

/** The row's verdict on one bash call: its refusal, or null. */
function verdict(r: Pick<Refusal, "row" | "command" | "cwd" | "extra">): { reason: string } | null {
	const ctx: CallContext = { role: "lane", cwd: r.cwd ?? "/tmp", env: { ...env, ...r.extra } };
	const call = { toolName: "bash", input: { command: r.command } };
	return r.row === 6 ? checkReserved(call, ctx) : checkRawLedgerWrite(call, ctx);
}

/** The head word of the last command the parser read: its text and whether it is opaque. */
function lastHead(command: string, extra: Record<string, string> = {}): { text: string; opaque: boolean } {
	const head = parseShell(command, { cwd: "/tmp", env: { ...env, ...extra } }).commands.at(-1)!.words[0]!;
	return { text: head.text, opaque: head.opaque };
}

const REFUSALS: Refusal[] = [
	// § Evidence on current main: every line returned ALLOW.
	{ name: "if", tag: "new", row: 6, command: "a=git; if false; then a=ls; fi; $a push origin main" },
	{ name: "&&", tag: "new", row: 6, command: "a=git; false && a=ls; $a push origin main" },
	{ name: "||", tag: "new", row: 6, command: "a=git; true || a=ls; $a push origin main" },
	{ name: "pipeline", tag: "new", row: 6, command: "a=git; a=ls | true; $a push origin main" },
	{ name: "&", tag: "new", row: 6, command: "a=git; a=ls & $a push origin main" },
	{ name: "loop body", tag: "new", row: 6, command: "a=git; while false; do a=ls; done; $a push origin main" },
	{ name: "break", tag: "new", row: 6, command: "a=ls; while true; do if true; then a=git; break; fi; a=ls; done; $a push origin main" },
	{ name: "continue", tag: "new", row: 6, command: "a=ls; for i in one; do a=git; continue; a=ls; done; $a push origin main" },
	{ name: "repeated join after case", tag: "new", row: 6, command: "read a <<<git; case x in y) a=ls;; esac; case x in y) :;; esac; $a push origin main" },
	{ name: "( … )", tag: "new", row: 6, command: "a=git; (a=ls); $a push origin main" },
	{ name: "if inside $( … )", tag: "new", row: 6, command: 'a=git; : "$(if false; then a=ls; fi; $a push origin main)"' },
	{ name: "if, path", tag: "new", row: 10, command: 'dest=/not-real/ledger.db; if false; then dest=/tmp/safe; fi; printf x > "$dest"' },
	{ name: "&&, path", tag: "new", row: 10, command: 'dest=/not-real/ledger.db; false && dest=/tmp/safe; printf x > "$dest"' },
	{ name: "cd under &&", tag: "new", row: 10, command: "cd /not-real; false && cd /tmp; printf x > ledger.db" },
	{ name: "failed cd, !", tag: "new", row: 10, command: "cd /not-real; ! cd /does-not-exist && printf x > ledger.db" },

	// The item 101 form: a substitution's or a process substitution's assignment leaves the parent's value.
	{ name: "$( a=ls ) leaves the parent", tag: "new", row: 6, command: 'a=git; : "$(a=ls)"; $a push origin main' },
	{ name: "`a=ls` leaves the parent", tag: "new", row: 6, command: "a=git; : `a=ls`; $a push origin main" },
	{ name: "<( a=ls ) leaves the parent", tag: "new", row: 6, command: "a=git; cat <(a=ls); $a push origin main" },

	// Assignment builtins that can fail before assigning.
	{ name: "local outside a function", tag: "new", row: 6, command: "a=git; local a=ls; $a push origin main" },
	{ name: "export with an unknown option", tag: "new", row: 6, command: "a=git; export -Z a=ls || $a push origin main" },
	{ name: "export with a failing redirect", tag: "new", row: 6, command: "a=git; export a=ls > /dev/null/nope || $a push origin main" },
	{ name: "readonly, then export", tag: "new", row: 6, command: "readonly a=git; if true; then export a=ls; $a push origin main; fi" },
	{ name: "declare -r, then export", tag: "new", row: 6, command: "declare -r a=git; if true; then export a=ls; $a push origin main; fi" },
	{ name: "readonly, then a plain assignment", tag: "new", row: 6, command: "readonly a=git; if true; then a=ls; $a push origin main; fi" },
	{ name: "declare -r, then a plain assignment", tag: "new", row: 6, command: "declare -r a=git; if true; then a=ls; $a push origin main; fi" },
	{ name: "declare -A on an indexed array", tag: "new", row: 6, command: "a=git; declare -a a; declare -A a=ls; $a push origin main" },
	{ name: "declare -g (bash 3.2 rejects it)", tag: "new", row: 6, command: "a=git; if true; then declare -g a=ls; $a push origin main; fi" },
	{ name: "export of a special name", tag: "new", row: 6, command: "if true; then export FUNCNAME=x; git${FUNCNAME} push origin main; fi" },
	{ name: "declare -x of a special name", tag: "new", row: 6, command: "if true; then declare -x FUNCNAME=x; git${FUNCNAME} push origin main; fi" },
	{ name: "plain assignment of a special name", tag: "new", row: 6, command: "FUNCNAME=x; git${FUNCNAME} push origin main" },
	{ name: "readonly partway through one readonly", tag: "new", row: 6, command: "a=ls; if true; then readonly a=git a=ls; $a push origin main; fi" },
	{ name: "readonly partway through one declare -r", tag: "new", row: 6, command: "a=ls; if true; then declare -r a=git a=ls; $a push origin main; fi" },
	{ name: "readonly partway through one typeset -rx", tag: "new", row: 6, command: "a=ls; if true; then typeset -rx a=git a=ls; $a push origin main; fi" },

	// A compound's exit keeps its last element's status alternatives.
	{ name: "{ ! cd X; } &&", tag: "new", row: 10, command: "{ ! cd /not-real/x; } && printf x > ledger.db", cwd: "/not-real" },
	{ name: "{ cd X; } ||", tag: "new", row: 10, command: "{ cd /not-real/x; } || printf x > ledger.db", cwd: "/not-real" },

	// select, for with no list, time.
	{ name: "select assigns its word or nothing", tag: "new", row: 6, command: "a=ls; select a in git; do break; done; $a push origin main" },
	{ name: "select with a reply out of range", tag: "new", row: 6, command: "suffix=x; select suffix in x; do break; done <<< 2; git${suffix} push origin main" },
	{ name: "for NAME; do (no list)", tag: "new", row: 6, command: "a=ls; for a; do :; done; $a push origin main" },
	{ name: "time if", tag: "new", row: 6, command: "a=git; time if false; then a=ls; fi; $a push origin main" },

	// elif/else; a || b && c.
	{ name: "else", tag: "new", row: 6, command: "a=git; if false; then :; elif false; then :; else a=ls; fi; $a push origin main" },
	{ name: "elif", tag: "new", row: 6, command: "a=git; if false; then :; elif true; then a=ls; fi; $a push origin main" },
	{ name: "a || b && c", tag: "new", row: 6, command: "a=git; false || a=ls && $a push origin main" },

	// ! cmd && …; ! a | b.
	{ name: "! cd && …", tag: "new", row: 10, command: "! cd /tmp && printf x > ledger.db", cwd: "/not-real" },
	{ name: "! a | b", tag: "new", row: 6, command: "a=git; ! a=ls | true; $a push origin main" },

	// until (the body starts from the condition's failure) and while ! ….
	{ name: "until false; do a=git; done", tag: "kept", row: 6, command: "a=ls; until false; do a=git; done; $a push origin main" },
	{ name: "until: the body runs where the cd failed", tag: "new", row: 10, command: "until cd /tmp; do printf x > ledger.db; done", cwd: "/not-real" },
	{ name: "until: no pass keeps the value", tag: "new", row: 6, command: "a=git; until false; do a=ls; done; $a push origin main" },
	{ name: "while ! cd", tag: "new", row: 10, command: "while ! cd /tmp; do printf x > ledger.db; done", cwd: "/not-real" },

	// Pipelines, and a group under &&.
	{ name: "cmd | while …; do a=…; done", tag: "new", row: 6, command: "a=git; true | while read x; do a=ls; done; $a push origin main" },
	{ name: "a pipeline's middle component", tag: "new", row: 6, command: "a=git; true | a=ls | true; $a push origin main" },
	{ name: "{ a=ls; } under &&", tag: "new", row: 6, command: "a=git; false && { a=ls; }; $a push origin main" },

	// A case arm containing && or ||.
	{ name: "case arm with &&", tag: "new", row: 6, command: "case x in x) a=git; false && a=ls; $a push origin main;; esac" },
	{ name: "case arm with ||", tag: "new", row: 6, command: "case x in x) a=git; true || a=ls; $a push origin main;; esac" },

	// Nested loops: break 2 and continue 2 leave the outer loop too.
	{ name: "break 2", tag: "new", row: 6, command: "a=ls; while true; do while true; do a=git; break 2; done; a=ls; done; $a push origin main" },
	{ name: "continue 2", tag: "new", row: 6, command: "a=ls; for i in one; do for j in one; do a=git; continue 2; done; a=ls; done; $a push origin main" },

	// The for variable.
	{ name: "for variable", tag: "new", row: 6, command: "a=ls; for a in git; do :; done; $a push origin main" },

	// Repeated joins keep the maybe-unknown mark (after case: the evidence line above).
	{ name: "repeated join after if", tag: "new", row: 6, command: "read a <<<git; if false; then a=ls; fi; if false; then :; fi; $a push origin main" },
	{ name: "repeated join after a pipeline", tag: "new", row: 6, command: "read a <<<git; true | a=ls; true | true; $a push origin main" },
	{ name: "repeated join after aliasing", tag: "kept", row: 6, command: "read a <<<git; case x in y) a=ls;; esac; b=$a; case x in y) b=ls;; esac; $b push origin main" },
	{
		name: "repeated join after aliasing through export, b in the environment",
		// allowed on the base (d46b94d): only the plain `b=$a` chain was already refused there
		tag: "new",
		row: 6,
		command: "read a <<<git; case x in y) a=ls;; esac; export b=$a; case x in y) b=ls;; esac; $b push origin main",
		extra: { b: "ls" },
	},

	// A failed cd leaves the directory.
	{ name: "cd X || …", tag: "new", row: 10, command: "cd /not-real/x || printf x > ledger.db", cwd: "/not-real" },

	// Code review r1 (CODE-REVIEW-r1.md), each allowed on d46b94d and on f0d0c4c; bash 3.2 oracle left `git`.
	{ name: "readonly with a computed name (r1 F1)", tag: "new", row: 6, command: "ab=git; read n <<<b; readonly a${n}=git; export ab=ls; $ab push origin main" },
	{ name: "declare with an opaque -r before its operands (r1 F2)", tag: "new", row: 6, command: "a=ls; read opts <<<-r; declare $opts a=git a=ls; $a push origin main" },
	{ name: "time -p if (r1 F3)", tag: "new", row: 6, command: "a=git; time -p if false; then a=ls; fi; $a push origin main" },
	{ name: "if split by a backslash-newline (r1 F4)", tag: "new", row: 6, command: "a=git; i\\\nf false; then a=ls; fi; $a push origin main" },
	// Found while fixing r1: a name an unquoted unknown expansion splits off, and a keyword after a subshell.
	{ name: "readonly with a name field splitting makes", tag: "new", row: 6, command: 'g=git; read y <<<"1 g"; x=h=; readonly ${x}$y; export g=ls; $g push origin main' },
	{ name: "then after a ( … ) condition", tag: "new", row: 6, command: "a=git; if (false) then a=ls; fi; $a push origin main" },
	// Code review r2 (CODE-REVIEW-r2.md, R2-F1), each allowed on dde8023; bash 3.2.57 oracle left `git`
	// (and, for readonly, `g: readonly variable`). A known unquoted `${x}` spelled the name and the `=`,
	// and its space split the operand into a second name.
	{ name: "declare with a known split prefix and a quoted unknown suffix (r2 R2-F1)", tag: "new", row: 6, command: 'g=ls; x="h=1 g="; read y <<<git; declare ${x}"$y"; $g push origin main' },
	{ name: "readonly with a known split prefix and a quoted unknown suffix (r2 R2-F1)", tag: "new", row: 6, command: 'g=git; x="h=1 g"; read y <<<""; readonly ${x}"$y"; export g=ls; $g push origin main' },
	// Fully quoted, the same operand does not split: bash 3.2.57 oracle left `g=ls` and set `h="1 g=git"`.
	// Refused all the same: an expansion spells the name and the `=`, and the gate reads an operand's name
	// only from literal source text (sl-cond-fix-r2, the conservative rule). Precision given up on purpose.
	{ name: "declare with a fully quoted known prefix (r2 R2-F1, conservative)", tag: "new", row: 6, command: 'g=ls; x="h=1 g="; read y <<<git; declare "${x}$y"; $g push origin main' },
	// Found while fixing r2: a literal quoted `NAME=` does not stop a later known unquoted expansion or an
	// unquoted glob from making more words. Bash 3.2.57 oracle: `declare "a="${z}"$y"` with `z="1 g="`
	// and `y=git` left `g=git`; `declare ?"=$y"` beside a file named `g=git` left `g=git`.
	{ name: "declare with a literal quoted name and a known split value", tag: "new", row: 6, command: 'g=ls; z="1 g="; read y <<<git; declare "a="${z}"$y"; $g push origin main' },
	{ name: "declare with a glob before a quoted =", tag: "new", row: 6, command: 'g=ls; read y <<<git; declare ?"=$y"; $g push origin main' },
	// Code review r3 (CODE-REVIEW-r3.md), each allowed on 5f73f95; bash 3.2.57 oracle left `g=git` (and,
	// for readonly, `g: readonly variable`). R3-F1: brace expansion made `{a,g}=` two names. R3-F2: bash
	// cut the ANSI-C quoted name at the NUL, so `$'g\0junk'=` named `g`. The gate now reads an operand's
	// name only when its raw source up to the first `=` is a plain identifier and `=` (sl-cond-fix-r3).
	{ name: "declare with a brace-expanded name list (r3 R3-F1)", tag: "new", row: 6, command: 'g=ls; read y <<<git; declare {a,g}="$y"; $g push origin main' },
	{ name: "readonly with a brace-expanded name list (r3 R3-F1)", tag: "new", row: 6, command: 'g=git; read y <<<git; readonly {a,g}="$y"; export g=ls; $g push origin main' },
	{ name: "declare with a brace-expanded name sequence (r3 R3-F1)", tag: "new", row: 6, command: 'g=ls; read y <<<git; declare {f..g}="$y"; $g push origin main' },
	{ name: "declare with an ANSI-C name cut at a NUL (r3 R3-F2)", tag: "new", row: 6, command: "g=ls; read y <<<git; declare $'g\\0junk'=\"$y\"; $g push origin main" },
	{ name: "readonly with an ANSI-C name cut at a NUL (r3 R3-F2)", tag: "new", row: 6, command: "g=git; read y <<<git; readonly $'g\\0junk'=\"$y\"; export g=ls; $g push origin main" },
	// Code review r4 (CODE-REVIEW-r4.md), each allowed on 1a78924; bash 3.2.57 oracle left `g=git` (and,
	// for readonly, `g: readonly variable`). R4-F1: an unquoted brace in the value made bash split it.
	// R4-F2: a builtin name not typed as plain text (quoted, escaped, expanded) made bash split the value.
	// The gate now reads an operand only under a head typed as plain text, and an assignment operand only
	// when it has no unquoted `{` (sl-cond-fix-r4).
	{ name: "declare with a brace list in the value (r4 R4-F1)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; declare a={one,two}$y; $g push origin main' },
	{ name: "declare with a brace range in the value (r4 R4-F1)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; declare a={1..2}$y; $g push origin main' },
	{ name: "readonly with a brace list in the value (r4 R4-F1)", tag: "new", row: 6, command: 'g=git; read y <<<"1 g"; readonly a={one,two}$y; export g=ls; $g push origin main' },
	{ name: "declare with a quoted head (r4 R4-F2)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; cmd=declare; "declare" a=$y; $g push origin main' },
	{ name: "declare with an escaped head (r4 R4-F2)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; decla\\re a=$y; $g push origin main' },
	{ name: "declare with a $cmd head (r4 R4-F2)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; cmd=declare; $cmd a=$y; $g push origin main' },
	{ name: "readonly with a quoted head (r4 R4-F2)", tag: "new", row: 6, command: 'g=git; read y <<<"1 g"; "readonly" a=$y; export g=ls; $g push origin main' },
	// The R4-F2 quoted head with a known value: bash 3.2.57 oracle (sl-cond-fix-r4) left `g=git`, `a=1`.
	{ name: "declare with a quoted head and a known value (r4 R4-F2)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; "declare" a=$y; $g push origin main' },
	// Found while fixing r4, bash 3.2.57 oracle: `declare {a,g}=$y` with a known `y=git` left `g=git` and
	// `a=git` (the gate does not brace-expand a word with an expansion); `declare g*` beside a file named
	// `g=git` left `g=git` (the operand is a glob).
	{ name: "declare with a brace-expanded name list and a known value", tag: "new", row: 6, command: "g=ls; y=git; declare {a,g}=$y; $g push origin main" },
	{ name: "declare with a glob operand", tag: "new", row: 6, command: "g=ls; declare g*; $g push origin main" },
	// A brace after a `${…}`, at the word's top level: bash 3.2.57 oracle (sl-cond-fix-r4) with
	// `y="1 g=git"` left `g=git` after `declare a=${z:-{}}{b,c}$y`.
	{ name: "declare with a brace after a ${…} in the value", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; declare a=${z:-{}}{b,c}$y; $g push origin main' },
	// Code review r5 (CODE-REVIEW-r5.md R5-F1), each allowed on 4acacda; bash 3.2.57 oracle left `g=git`
	// (and, for readonly, `g: readonly variable`): a prefix assignment before the builtin drops the
	// assignment-word reading, so bash field-splits the value. The gate now reads an operand only when no
	// prefix assignment precedes the head (sl-cond-fix-r5). The `$( … )` and backquote bodies printed
	// `git` in the r5 oracle; sl-cond-fix-r5 oracle: a redirect before the prefix assignment left `g=git`.
	{ name: "declare after a prefix assignment, known value (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; X=1 declare a=$y; $g push origin main' },
	{ name: "declare after a prefix assignment, read value (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; read y <<<"1 g=git"; X=1 declare a=$y; $g push origin main' },
	{ name: "readonly after a prefix assignment (r5 R5-F1)", tag: "new", row: 6, command: 'g=git; y="1 g"; X=1 readonly a=$y; export g=ls; $g push origin main' },
	{ name: "export after a prefix assignment (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; X=1 export a=$y; $g push origin main' },
	{ name: "typeset after a prefix assignment (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; X=1 typeset a=$y; $g push origin main' },
	{ name: "declare after a prefix assignment inside $( … ) (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; echo $(X=1 declare a=$y; $g push origin main)' },
	{ name: "declare after a prefix assignment inside backquotes (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; echo `X=1 declare a=$y; $g push origin main`' },
	{ name: "declare after a redirect and a prefix assignment (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; >/dev/null X=1 declare a=$y; $g push origin main' },
	{ name: "declare after a prefix assignment and a redirect (r5 R5-F1)", tag: "new", row: 6, command: 'g=ls; y="1 g=git"; X=1 >/dev/null declare a=$y; $g push origin main' },
	// builtin and command run the declaration builtin as a wrapped form, which row 6 refuses already.
	{ name: "builtin declare (wrapped form)", tag: "kept", row: 6, command: 'g=ls; read y <<<"1 g=git"; builtin declare a=$y; $g push origin main' },
	{ name: "command declare (wrapped form)", tag: "kept", row: 6, command: 'g=ls; read y <<<"1 g=git"; command declare a=$y; $g push origin main' },
];

describe("item 101 refusals: an assignment or cd on some paths is a candidate, not a fact", () => {
	for (const r of REFUSALS) {
		test(`[${r.tag}] row ${r.row}: ${r.name}`, () => {
			expect(verdict(r)).not.toBeNull();
		});
	}
});

describe("allow controls: verdicts that must not drift", () => {
	test("cd X && cmd judges cmd in X", () => {
		expect(verdict({ row: 6, command: "cd /tmp && git push origin feature" })).toBeNull();
	});
	test("an if with no assignment", () => {
		expect(verdict({ row: 6, command: "if test -f x; then echo hi; fi; git status" })).toBeNull();
	});
	test("a value every exit of an if agrees on stays known", () => {
		const command = "x=1; if c; then x=1; fi; echo $x";
		expect(verdict({ row: 6, command })).toBeNull();
		const last = parseShell(command, { cwd: "/tmp", env }).commands.at(-1)!;
		expect(last.words.map((w) => [w.text, w.opaque])).toEqual([
			["echo", false],
			["1", false],
		]);
	});
	test("case arms that assign unprotected paths", () => {
		expect(verdict({ row: 10, command: 'case x in a) out=/tmp/a;; b) out=/tmp/b;; esac; printf x > "$out"' })).toBeNull();
	});
	test("a pipeline that assigns the value it already has", () => {
		expect(verdict({ row: 6, command: "a=ls; a=ls | true; $a status" })).toBeNull();
	});
	test("export keeps its value known", () => {
		const command = "export FOO=bar; echo $FOO";
		expect(verdict({ row: 6, command })).toBeNull();
		const last = parseShell(command, { cwd: "/tmp", env }).commands.at(-1)!;
		expect(last.words.map((w) => [w.text, w.opaque])).toEqual([
			["echo", false],
			["bar", false],
		]);
	});
	// A `{` inside `${…}`, `$(…)` or backquotes is not one in the word's top-level source: bash 3.2.57
	// oracle (sl-cond-fix-r4), each with `y="1 g=git"`, left `g=ls` after `declare a=${y:-{b,c}}`,
	// `declare a=${z:-{}{b,c}}$y`, `declare a=$(echo {b,c})$y` and `` declare a=`echo {b,c}`$y ``.
	for (const [name, command] of [
		["export PATH=${HOME}/bin", "a=ls; export PATH=${HOME}/bin; $a status"],
		["declare a=${y:-{b,c}}", 'g=ls; read y <<<"1 g=git"; declare a=${y:-{b,c}}; $g status'],
		["declare a=${z:-{}{b,c}}$y", 'g=ls; read y <<<"1 g=git"; declare a=${z:-{}{b,c}}$y; $g status'],
		["declare a=$(echo {b,c})$y", 'g=ls; read y <<<"1 g=git"; declare a=$(echo {b,c})$y; $g status'],
		["declare a=`echo {b,c}`$y", 'g=ls; read y <<<"1 g=git"; declare a=`echo {b,c}`$y; $g status'],
	] as const) {
		test(`a brace inside an expansion keeps the assignment operand: ${name}`, () => {
			expect(verdict({ row: 6, command })).toBeNull();
			expect(lastHead(command)).toEqual({ text: "ls", opaque: false });
		});
	}
});

describe("parser precision", () => {
	test("( … ) is isolated: the head after it is the parent's own, definite", () => {
		expect(lastHead("a=ls; (a=git); $a status")).toEqual({ text: "ls", opaque: false });
	});
	test("aliasing a maybe-unknown value keeps it opaque through a later join", () => {
		expect(lastHead("read a <<<git; case x in y) a=ls;; esac; b=$a; case x in y) b=ls;; esac; $b push origin main").opaque).toBe(true);
		expect(lastHead("read a <<<git; case x in y) a=ls;; esac; export b=$a; case x in y) b=ls;; esac; $b push origin main", { b: "ls" }).opaque).toBe(true);
	});
	test("an opaque value with a literal name leaves other names definite (r1 F1)", () => {
		expect(lastHead("a=ls; export FOO=$(date); readonly BAZ=$(date); $a status")).toEqual({ text: "ls", opaque: false });
	});
	test("an opaque operand whose name is quoted makes every name maybe-unknown (r3, conservative)", () => {
		// `"BAR=$(date)"` assigns only BAR in bash, but its source before the `=` is not a plain
		// identifier, so the gate does not read its name: it may be an option or any number of names.
		// Precision given up on purpose: one whitelist rule on source instead of a model per shape.
		expect(lastHead('a=ls; export FOO=$(date) "BAR=$(date)"; readonly BAZ=$(date); $a status').opaque).toBe(true);
	});
	test("an assignment operand under the literal head keeps a known value one word (r4 control)", () => {
		// bash 3.2.57 oracle: `g=ls; y="1 g=git"; declare a=$y` left `g=ls` and `a="1 g=git"`.
		expect(lastHead('g=ls; y="1 g=git"; declare a=$y; $g status')).toEqual({ text: "ls", opaque: false });
	});
	test("a redirect alone keeps the assignment operand under the literal head (r5 control)", () => {
		// sl-cond-fix-r5 bash 3.2.57 oracle: `>/dev/null declare a=$y` and `declare a=$y >/dev/null` with
		// `y="1 g=git"` left `g=ls` and `a="1 g=git"`; only a prefix assignment drops the reading.
		expect(lastHead('g=ls; y="1 g=git"; >/dev/null declare a=$y; $g status')).toEqual({ text: "ls", opaque: false });
		expect(lastHead('g=ls; y="1 g=git"; declare a=$y >/dev/null; $g status')).toEqual({ text: "ls", opaque: false });
	});
	test("a prefix assignment before an assignment builtin makes every name maybe-unknown (r5 R5-F1)", () => {
		expect(lastHead('g=ls; y="1 g=git"; X=1 declare a=$y; $g status').opaque).toBe(true);
	});
	test("literal options and bare names under the literal head leave other names definite (r4)", () => {
		expect(lastHead("a=ls; export FOO; declare -r B=1; typeset -x C; $a status")).toEqual({ text: "ls", opaque: false });
	});
	test("an assignment builtin whose head is not typed as plain text makes every name maybe-unknown (r4, conservative)", () => {
		// `"export" FOO=bar` assigns only FOO in bash; the gate reads no operand under a quoted head.
		expect(lastHead('a=ls; "export" FOO=bar; $a status').opaque).toBe(true);
	});
	test("time -p is part of the keyword: the head after it is the command (r1 F3)", () => {
		expect(lastHead("time -p git status")).toEqual({ text: "git", opaque: false });
	});
});
