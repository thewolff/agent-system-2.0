// A POSIX-shell parser for the tool-call rows (6 reserved, 8 push, 10 raw ledger). It turns a
// command string into simple commands whose words have quoting removed and expansions applied,
// so a gate matches what the shell would run, not how it was spelled (astra review B1: `rm '-rf'`
// and `git "reset" --hard` were read as different commands from `rm -rf` and `git reset --hard`).
//
// What it models: single, double and ANSI-C quoting; backslash escapes and line continuations;
// `;` `&` `&&` `||` `|` `|&` and newlines; `( … )` subshells and `{ … }` groups; `case … esac`
// (every arm's commands, since which pattern matches is not known); `$(…)`, backticks
// and `<(…)`/`>(…)` (parsed as commands in their own right, their value unknown); `$VAR`/`${VAR}`
// from assignments earlier in the same command, then the session environment; `~`; brace
// expansion; redirections, heredocs (with their bodies) and herestrings; `cd` for the directory
// later commands run in. A word whose value cannot be known (a substitution, an unknown variable)
// is marked `opaque`; the rows decide what an opaque word means for them (usually: refuse).
// Anything the parser cannot read (an unterminated quote or substitution) is a `failure`, and the
// rows fail closed on failures.
//
// The values words are expanded with follow control flow (MIGRATION.md item 101, PLAN
// wl-mv4rzy6vmvjeo0): `&&`/`||`, `!`, pipelines, `&`, `if`/`elif`/`else`, `while`/`until`/`for`/
// `select` with `break N`/`continue N`, `{ … }` and `case` decide which state each command starts
// in, and where paths meet their states are joined, so a value set on only some paths is a maybe-
// unknown candidate, never a fact. `( … )`, `$( … )`, `<( … )`/`>( … )` and backticks work on a copy
// of the variables. Loops are modeled as zero or one pass.
import { resolve as resolvePath } from "node:path";

export interface Word {
	/** The value after quote removal and expansion; opaque parts contribute nothing. */
	text: string;
	/** Part of the value is unknown at gate time (substitution, unknown variable, `$@`, …). */
	opaque: boolean;
	/**
	 * An unquoted glob character (`*`, `?`, `[…]`) the shell expands against the filesystem when the
	 * command runs, so `text` is a pattern, not the value (astra review round 2, R2-B1: `/bin/r[m]`).
	 */
	glob?: boolean;
	/**
	 * The word's spelling carries an expansion (`$VAR`, `${…}`, `$(…)`, backticks, `$'…'`, brace
	 * expansion), known or not: it is not fully literal. The inverted default (M4 fix round 3) models
	 * only literal spellings for a command name and a `git -C` path.
	 */
	expanded?: boolean;
	/**
	 * Where the word sits in the source, `[start, end)`, for a caller that masks a word in the raw
	 * text (row 6's data words, PLAN wl-mupzpidbb3ksg0 § 1). Set only when `parseShell` is called with
	 * `spans: true`, on words of that string and of `( … )`/`$( … )` inside it; never on a backtick or
	 * heredoc body, never on a word brace expansion or field splitting produced, never on an opaque
	 * word. Offsets index the source after `\r\n`/`\r` became `\n`: they index the caller's string
	 * only when it has no CR.
	 */
	span?: [number, number];
	/**
	 * Values an opaque word may take that the gate knows: a variable assigned on some paths only
	 * (a `case` arm, PR #49 review B3; an `if`/`&&`/`||` branch, a loop body, a failing builtin,
	 * MIGRATION item 101), used after the paths join. The gate does not know which path ran, so the
	 * word is opaque; a row judging paths refuses when any candidate is a protected path. The list
	 * is complete only when the variable was known on every path; on an unknown path it is unknown,
	 * and the word is opaque either way.
	 */
	candidates?: string[];
}

export interface Redirect {
	/** `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<-`, `<<<`, `>&`, `<&`. */
	op: string;
	/** The file (or fd) word; null for a heredoc. */
	target: Word | null;
	/** Heredoc or herestring text. */
	body: string | null;
	/** The body contains expansions whose value is unknown. */
	bodyOpaque: boolean;
}

export interface SimpleCommand {
	words: Word[];
	redirects: Redirect[];
	/** Directory the command runs in (after earlier `cd`s). */
	dir: string;
	/** False once a `cd` to an unknown directory ran before this command. */
	dirKnown: boolean;
	/** The command whose stdout feeds this one's stdin, in a pipeline. */
	stdinFrom: SimpleCommand | null;
	/** Parsed at the top level of the source string (not inside `( … )`, `$( … )`, backticks or a heredoc). */
	top: boolean;
}

export interface ParseResult {
	commands: SimpleCommand[];
	failures: string[];
	/** List operators at the top level, in order (`;` `&&` `||` `|` `&` newline, and `(` for a subshell). */
	ops: string[];
	/** Keywords dropped from command position at the top level (`!`, `if`, `{`, …). */
	keywords: string[];
}

export interface ParseOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	/** Record each word's `span` (see Word.span). Only the top-level parse of a command string the caller holds opts in. */
	spans?: boolean;
}

/**
 * A variable's value in this command string: known; one of the listed known values or unknown (the
 * maybe-unknown mark: paths that disagree met, or a word built from such a value was assigned — it
 * becomes definite again only through a definite assignment); or unknown.
 */
export type VarValue = string | string[] | null;

const OPAQUE = Symbol("opaque");
/** A piece of a word: `q` 0 = unquoted literal, 1 = quoted or escaped, 2 = unquoted expansion result. */
interface Seg {
	s: string;
	q: 0 | 1 | 2;
}
/** A piece whose value is one of `alts` (a case-joined variable). */
interface Alts {
	alts: string[];
}
type Part = Seg | Alts | typeof OPAQUE;
const isSeg = (p: Part): p is Seg => p !== OPAQUE && "s" in p;
/** More candidate values than one word is followed through (a product of joined variables). */
const MAX_CANDIDATES = 64;
/** One character of a word: `active` = unquoted (glob characters work), `split` = from an unquoted expansion (IFS splits it). */
interface Ch {
	c: string;
	active: boolean;
	split?: boolean;
}

/**
 * Does the word carry an unquoted glob: `*`, `?`, or a `[` closed by a later `]`?
 * Sources, fetched in M4 fix round 4: POSIX § 2.14 Pattern Matching Notation
 * (https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html) and the bash manual,
 * Pattern Matching (https://www.gnu.org/software/bash/manual/bash.html: "If the first character
 * following the [ is a ‘!’ or a ‘^’ then any character not within the range matches").
 * The gate never evaluates a match; it only flags the word, and every caller treats a flagged word
 * as unknown. Deviations, each toward flagging more: a `[` counts whatever sits inside it, so `[!x]`,
 * `[^x]` and character classes are all flagged alike, and `[ab` with no `]` is not a glob (as in
 * bash). Not modeled here: extglob `@( ) !( ) ?( ) *( ) +( )`, refused as unreadable by the parser
 * instead; `dotglob`, `nullglob`, `failglob`, `nocaseglob` and `globstar`, which change only what a
 * flagged word would match.
 */
function hasGlob(chars: Ch[]): boolean {
	for (let k = 0; k < chars.length; k++) {
		const ch = chars[k]!;
		if (!ch.active) continue;
		if (ch.c === "*" || ch.c === "?") return true;
		if (ch.c === "[" && chars.slice(k + 2).some((x) => x.c === "]")) return true;
	}
	return false;
}

/**
 * POSIX field splitting of one word's characters on IFS (only characters from an unquoted expansion
 * split). IFS whitespace runs collapse and trim; each other IFS character ends a field, empty or not.
 * Sources, fetched in M4 fix round 4: POSIX § 2.6.5 Field Splitting ("If the IFS variable is set and
 * has an empty string as its value, no field splitting shall occur"; unset IFS splits as
 * <space><tab><newline>) and the bash manual, Word Splitting ("If IFS is unset, word splitting
 * behaves as if its value were <space><tab><newline>"; "Space, tab, and newline are always
 * considered IFS whitespace"). The caller handles unset, empty and unknown IFS (an IFS the gate
 * cannot read makes the word opaque). Deviation: "IFS whitespace" here is JavaScript `\s`, which also
 * covers `\v`, `\f` and Unicode spaces; bash counts space, tab, newline and the locale's space class.
 * The two differ only for an IFS that contains one of those extra characters.
 */
function splitFields(chars: Ch[], ifs: string, emptyQuoted: boolean): Word[] {
	const fields: Ch[][] = [];
	let cur: Ch[] = [];
	let has = false;
	let afterWs = false;
	for (const ch of chars) {
		if (ch.split && ifs.includes(ch.c)) {
			if (/\s/.test(ch.c)) {
				if (has) fields.push(cur);
				cur = [];
				has = false;
				afterWs = true;
			} else {
				if (has || !afterWs) fields.push(cur);
				cur = [];
				has = false;
				afterWs = false;
			}
			continue;
		}
		cur.push(ch);
		has = true;
		afterWs = false;
	}
	if (has) fields.push(cur);
	if (fields.length === 0 && emptyQuoted) fields.push([]);
	return fields.map((f) => ({ text: f.map((x) => x.c).join(""), opaque: false, glob: hasGlob(f) }));
}

const DEFAULT_IFS = " \t\n";

const IS_BLANK = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\r";
const ENDS_WORD = (c: string | undefined): boolean => c === undefined || IS_BLANK(c) || c === "\n" || ";&|<>()".includes(c);
/** The terminator of a `case` arm at `i`: `;;`, `;&` or `;;&` (bash; the last two fall through), else null. */
const ARM_END = (src: string, i: number): string | null => (src.startsWith(";;&", i) ? ";;&" : src.startsWith(";;", i) || src.startsWith(";&", i) ? src.slice(i, i + 2) : null);

/** Shell keywords that are not commands: dropped from command position. */
const KEYWORDS: Record<string, true> = { if: true, then: true, else: true, elif: true, fi: true, do: true, done: true, while: true, until: true, "!": true, "{": true, "}": true, "[[": true, time: true };
/** The same keywords, recognised on the raw source in command position, where they drive the control-flow frames (Parser.keyword). */
const FLOW_KEYWORDS = Object.keys(KEYWORDS);
/**
 * The keywords whose event changes the frames or the status (Parser.keyword). Bash reads one only where
 * the raw source spells it in command position; quoted, expanded or after a redirect it is a command
 * name and the line around it is usually a syntax error (bash 3.2 oracle, sl-cond-fix-r1: `"if" false;
 * then …`, `>/dev/null if false; then …` and `b=1 if false; then …` all stopped at `then`).
 */
const FRAME_KEYWORDS: Record<string, true> = { if: true, then: true, else: true, elif: true, fi: true, do: true, done: true, while: true, until: true, "!": true, "{": true, "}": true };
/** An assignment word: `NAME=…`. */
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Shell-special variables: an assignment of any kind to one (plain, builtin, loop or `read`) leaves it
 * unknown, because bash or zsh may reject, ignore or recompute it (PLAN wl-mv4rzy6vmvjeo0 r5 F2: on
 * bash 3.2 `export FUNCNAME=x` returned 1 and `$FUNCNAME` expanded empty). Copied on 2026-10-12 from
 * the bash manual's § 5.2 "Bash Variables", fetched from the maintainer's copy
 * https://tiswww.case.edu/php/chet/bash/bashref.html#Bash-Variables (the same text as
 * https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html, which did not answer from
 * here), and from the zsh manual's § 15.5 "Parameters Set By The Shell"
 * (https://zsh.sourceforge.io/Doc/Release/Parameters.html#Parameters-Set-By-The-Shell). Names that are
 * not identifiers (`!`, `#`, `$`, `?`, …) cannot be assigned and are left out; so are the values
 * `zsh_eval_context` lists. Every name starting `BASH`, `COMP_` or `READLINE_` is special too.
 */
const SPECIAL: Record<string, true> = Object.fromEntries(
	(
		// bash, "Bash Variables"
		"BASH BASHOPTS BASHPID BASH_ALIASES BASH_ARGC BASH_ARGV BASH_ARGV0 BASH_CMDS BASH_COMMAND " +
		"BASH_COMPAT BASH_ENV BASH_EXECUTION_STRING BASH_LINENO BASH_LOADABLES_PATH BASH_MONOSECONDS " +
		"BASH_REMATCH BASH_SOURCE BASH_SUBSHELL BASH_TRAPSIG BASH_VERSINFO BASH_VERSION BASH_XTRACEFD " +
		"CHILD_MAX COLUMNS COMPREPLY COMP_CWORD COMP_KEY COMP_LINE COMP_POINT COMP_TYPE COMP_WORDBREAKS " +
		"COMP_WORDS COPROC DIRSTACK EMACS ENV EPOCHREALTIME EPOCHSECONDS EUID EXECIGNORE FCEDIT FIGNORE " +
		"FUNCNAME FUNCNEST GLOBIGNORE GLOBSORT GROUPS HISTCMD HISTCONTROL HISTFILE HISTFILESIZE " +
		"HISTIGNORE HISTSIZE HISTTIMEFORMAT HOSTFILE HOSTNAME HOSTTYPE IGNOREEOF INPUTRC INSIDE_EMACS " +
		"LANG LC_ALL LC_COLLATE LC_CTYPE LC_MESSAGES LC_NUMERIC LC_TIME LINENO LINES MACHTYPE MAILCHECK " +
		"MAPFILE OLDPWD OPTERR OSTYPE PIPESTATUS POSIXLY_CORRECT PPID PROMPT_COMMAND PROMPT_DIRTRIM PS0 " +
		"PS3 PS4 PWD RANDOM READLINE_ARGUMENT READLINE_LINE READLINE_MARK READLINE_POINT REPLY SECONDS " +
		"SHELL SHELLOPTS SHLVL SRANDOM TIMEFORMAT TMOUT TMPDIR UID _ histchars " +
		// zsh, "Parameters Set By The Shell"
		"ARGC argv status pipestatus _ CPUTYPE EGID EUID ERRNO FUNCNEST GID HISTCMD HOST LINENO LOGNAME " +
		"MACHTYPE OLDPWD OPTARG OPTIND OSTYPE PPID PWD RANDOM SECONDS SHLVL signals TRY_BLOCK_ERROR " +
		"TRY_BLOCK_INTERRUPT TTY TTYIDLE UID USERNAME VENDOR zsh_eval_context ZSH_EVAL_CONTEXT " +
		"ZSH_ARGZERO ZSH_EXECUTION_STRING ZSH_NAME ZSH_PATCHLEVEL zsh_scheduled_events ZSH_SCRIPT " +
		"ZSH_SUBSHELL ZSH_VERSION"
	)
		.split(" ")
		.map((name) => [name, true]),
);

/**
 * The names that may be readonly at one point of the source, or `all` once something the gate cannot
 * see (an assignment builtin with a word whose name is unknown, `source`, `.`, `eval`) may have marked
 * any name. Never changed in place: a new name makes a new set, so states can share one.
 */
type RoSet = ReadonlySet<string> | "all";
/** Bash's own readonly variables, where every command string starts; the attribute is not inherited through the environment. */
const BASH_READONLY: RoSet = new Set(["BASHOPTS", "BASH_VERSINFO", "EUID", "PPID", "SHELLOPTS", "UID"]);

/**
 * The value a variable has when any one of `values` may be the one: a known value every path agrees
 * on stays known; otherwise the known values, as the maybe-unknown array (see VarValue); none known is
 * unknown. An array in, or an unknown, keeps the result an array: the mark is monotonic.
 */
function joinValues(values: VarValue[]): VarValue {
	const known = new Set<string>();
	let maybeUnknown = false;
	for (const v of values) {
		if (v === null) maybeUnknown = true;
		else if (typeof v === "string") known.add(v);
		else {
			maybeUnknown = true;
			for (const x of v) known.add(x);
		}
	}
	if (known.size === 0) return null;
	return !maybeUnknown && known.size === 1 ? [...known][0]! : [...known];
}

/**
 * What wordParts records of a word's raw source for the assignment builtins (`export`, `readonly`,
 * `declare`, `typeset`, `local`). PLAIN_SOURCE: the raw source is exactly the word's text, so it has no
 * quote, backslash, expansion, tilde, brace expansion or line continuation. ASSIGNMENT_SOURCE: the raw
 * source matches ASSIGNMENT (plain unquoted identifier characters, not a digit first, then `=`) and has
 * no unquoted `{` in its own top-level source, outside quotes and outside every `${…}`, `$(…)` and
 * backquote construct: bash 3.2.57 (sl-cond-fix-r4, `y="1 g=git"`) did not brace-expand or split
 * `declare a=${y:-{b,c}}`, `declare a=${z:-{}{b,c}}$y`, `declare a=$(echo {b,c})$y` or the backquote
 * form, and did both for `declare a=${z:-{}}{b,c}$y`.
 *
 * An assignment builtin's operand gets assignment-word treatment (no field splitting, one name, the
 * name known when the value is opaque, the command precise when the value is known) only when both
 * hold: (a) the command's head word is PLAIN_SOURCE, the builtin's name typed as plain literal text,
 * and no prefix assignment precedes it in the same simple command; (b) the operand is
 * ASSIGNMENT_SOURCE. Under such a head an operand that is PLAIN_SOURCE with no glob
 * character and no `{` (an option such as `-r`, a bare name such as `FOO`) is read as the literal word
 * it is. Every other operand of an assignment builtin, known or opaque, is unreadable: it may be an
 * option or any number of `NAME[=value]` words. One whitelist on source, not a model of what bash makes
 * of each shape. Each shape below made bash assign a name the gate's reading did not show. Bash 3.2
 * oracle, sl-cond-fix-r1: `readonly a${n}=git` with `n=b` marked `ab`; `declare ${x}$y` with `x=h=`
 * and `y="f=git g=git"` assigned `g`. Bash 3.2.57 oracle, sl-cond-fix-r2 (review r2 R2-F1), each with
 * `g=ls` and an unknown `y=git`: `declare ${x}"$y"` with `x="h=1 g="` and `declare "a="${z}"$y"` with
 * `z="1 g="` assigned `g=git`; `declare ?"=$y"` beside a file named `g=git` assigned `g=git`. Review r3
 * (CODE-REVIEW-r3.md), bash 3.2.57: `declare {a,g}="$y"` and `declare {f..g}="$y"` (brace expansion,
 * R3-F1) and `declare $'g\0junk'="$y"` (ANSI-C quoting cut at the NUL, R3-F2) assigned `g=git`. Review
 * r4 (CODE-REVIEW-r4.md), bash 3.2.57, each with `g=ls` and `y="1 g=git"`: `declare a={one,two}$y` and
 * `declare a={1..2}$y` (R4-F1, a brace in the value) and `"declare" a=$y`, `decla\re a=$y` and
 * `$cmd a=$y` with `cmd=declare` (R4-F2, a head not typed as plain text) assigned `g=git`.
 * sl-cond-fix-r4, bash 3.2.57: `declare {a,g}=$y` with a known `y=git`, and `declare g*` beside a file
 * named `g=git`, assigned `g=git`. Review r5 (CODE-REVIEW-r5.md R5-F1), bash 3.2.57, with `g=ls` and
 * `y="1 g=git"`: `X=1 declare a=$y`, `X=1 export a=$y` and `X=1 typeset a=$y` assigned `g=git` (a
 * prefix assignment drops the assignment-word reading), and sl-cond-fix-r5 found the same for
 * `>/dev/null X=1 declare a=$y` and `X=1 >/dev/null declare a=$y`, while `>/dev/null declare a=$y`
 * and `declare a=$y >/dev/null` (a redirect, no prefix assignment) left `g=ls`. Both conditions held,
 * bash 3.2.57 left `declare a=$y` with `y="1 g=git"` assigning `a` only.
 */
const PLAIN_SOURCE = new WeakSet<Word>();
const ASSIGNMENT_SOURCE = new WeakSet<Word>();

/** An assignment-builtin operand the gate cannot read (see PLAIN_SOURCE); `plainHead` is condition (a): the head typed as plain literal text, no prefix assignment before it. */
const unreadOperand = (w: Word, plainHead: boolean): boolean =>
	!plainHead || !(ASSIGNMENT_SOURCE.has(w) || (PLAIN_SOURCE.has(w) && !w.glob && !w.text.includes("{")));

/**
 * An assignment builtin (`head`, typed as plain text when `plainHead`, with `operands` and
 * `redirected`) that cannot fail before assigning a valid, ordinary name: `export` and `readonly` with
 * no option, `declare`/`typeset` with only `-r` and `-x`, no redirect, no operand the gate cannot read.
 * Lane oracle 2026-10-12: `a=git; export 1b=x a=ls` still set `a=ls`. `local` is never precise: outside
 * a function it fails without assigning, and the gate does not track function context. `-g` is not
 * precise either: bash 3.2 rejects it (r5 F1).
 */
function precise(head: string, plainHead: boolean, operands: Word[], redirected: boolean): boolean {
	if (head === "local" || redirected) return false;
	for (const w of operands) {
		if (unreadOperand(w, plainHead)) return false;
		if (w.opaque || !/^[-+]/.test(w.text)) continue;
		if (head === "export" || head === "readonly" || !/^-[rx]+$/.test(w.text)) return false;
	}
	return true;
}

interface PendingHeredoc {
	redirect: Redirect;
	delim: string;
	expand: boolean;
	stripTabs: boolean;
}

/** The parser's state at one point of the source (see Parser.snapshot). Never changed once made. */
interface State {
	vars: Map<string, VarValue>;
	dir: string;
	known: boolean;
	ro: RoSet;
}

/** What one element (a command, a pipeline, a compound, an and-or list) leaves: on success, on failure, and for a next command that does not test its status. */
interface Flow {
	ok: State;
	fail: State;
	any: State;
}
const flat = (s: State): Flow => ({ ok: s, fail: s, any: s });

/**
 * One sequence of and-or lists: a list() call, or the current part of a compound frame (a condition,
 * a branch, a loop body). It folds each element into its pipeline, each pipeline into its and-or
 * list, and each and-or list into `last` (PLAN wl-mv4rzy6vmvjeo0 § Status transfer).
 */
interface Seq {
	/** The current pipeline: the state it started in, how many `|` so far, a `!` before it, and its last element's flow. */
	pipeStart: State | null;
	piped: number;
	negate: boolean;
	elem: Flow | null;
	/** The current and-or list: the state it started in (for `&`), its folded flow, the operator waiting for its pipeline, and how many operators ran. */
	aoStart: State | null;
	acc: Flow | null;
	op: "&&" | "||" | null;
	ops: number;
	/** The flow of the last and-or list that ended, or the sequence's start state. */
	last: Flow;
}
const newSeq = (s: State): Seq => ({ pipeStart: null, piped: 0, negate: false, elem: null, aoStart: null, acc: null, op: null, ops: 0, last: flat(s) });

/** An open compound: `if`, a `while`/`until`/`for`/`select` loop, or `{ … }`. */
interface Frame {
	kind: "if" | "while" | "until" | "for" | "{";
	/** The sequence the compound is one element of, resumed when it closes. */
	outer: Seq;
	start: State;
	/** Every state a path out of the compound may leave (see closeFrame). */
	exits: State[];
	/** `if`: "cond" until `then`, "body" after it; a loop: "cond" until `do`; `{`: "body". */
	phase: "cond" | "body";
	/** `if`: the last condition's failure state, where `elif`/`else` start and the no-branch exit; null after `else`. */
	condFail: State | null;
	/** `for`/`select`: the state the body starts in (the loop variable assigned). */
	body: State | null;
}
const isLoop = (f: Frame): boolean => f.kind === "while" || f.kind === "until" || f.kind === "for";

class Parser {
	i = 0;
	readonly commands: SimpleCommand[];
	readonly failures: string[];
	readonly ops: string[] = [];
	readonly keywords: string[] = [];
	/** This parser reads the top level of the source (no sink: not a nested or sub parse). */
	readonly top: boolean;
	dir: string;
	dirKnown = true;
	/** Names that may be readonly here (see RoSet). */
	ro: RoSet;
	private pending: PendingHeredoc[] = [];
	/** The sequence the innermost list() call or frame part folds. Set by list(). */
	private seq!: Seq;
	/** The compound frames open in this parser, innermost last; each list() call owns the ones from `base` up. */
	private readonly frames: Frame[] = [];
	private base = 0;

	constructor(
		readonly src: string,
		readonly opts: ParseOptions,
		readonly vars: Map<string, VarValue>,
		sink?: { commands: SimpleCommand[]; failures: string[] },
		scope?: { dir: string; known: boolean; ro: RoSet },
		/** Record word spans: set by parseShell from `opts.spans`, kept by `nested`, never by a `sub` or heredoc parser. */
		readonly spans = false,
	) {
		this.top = sink === undefined;
		this.commands = sink?.commands ?? [];
		this.failures = sink?.failures ?? [];
		this.dir = scope?.dir ?? opts.cwd;
		this.dirKnown = scope?.known ?? true;
		this.ro = scope?.ro ?? BASH_READONLY;
	}

	private op(token: string): void {
		if (this.top) this.ops.push(token);
	}

	private get ch(): string | undefined {
		return this.src[this.i];
	}

	private skipBlanks(): void {
		for (;;) {
			if (IS_BLANK(this.ch)) this.i++;
			else if (this.ch === "\\" && this.src[this.i + 1] === "\n") this.i += 2;
			else return;
		}
	}

	/** Blanks, newlines and comments: where a `case` allows a line break (before `in`, before a pattern). */
	private skipLines(): void {
		for (;;) {
			this.skipBlanks();
			if (this.ch === "\n") this.i++;
			else if (this.ch === "#") while (this.ch !== undefined && this.ch !== "\n") this.i++;
			else return;
		}
	}

	/**
	 * Where an unquoted `kw` that starts at `i` ends as a word, or -1 (`esac;` yes, `esacx` and `"esac"`
	 * no). Bash removes a backslash-newline before it splits words, so one may sit inside or after the
	 * keyword (bash 3.2 oracle, sl-cond-fix-r1: `i\<newline>f false; then a=ls; fi` ran as an `if`, and
	 * `time -\<newline>p` as `time -p`). Only literal characters match: a quote, an escape of another
	 * character or an expansion never makes a keyword.
	 */
	private keywordEnd(kw: string): number {
		let j = this.i;
		for (let k = 0; ; k++) {
			const end = j;
			while (this.src[j] === "\\" && this.src[j + 1] === "\n") j += 2;
			if (k === kw.length) return ENDS_WORD(this.src[j]) ? end : -1;
			if (this.src[j] !== kw[k]) return -1;
			j++;
		}
	}

	private atKeyword(kw: string): boolean {
		return this.keywordEnd(kw) >= 0;
	}

	/** The directory and readonly scope a child parser starts from. */
	private scope(): { dir: string; known: boolean; ro: RoSet } {
		return { dir: this.dir, known: this.dirKnown, ro: this.ro };
	}

	/**
	 * A nested parser over the same source (`( … )`, `$( … )`, `<( … )`/`>( … )`), sharing output, with
	 * its own copy of the variables and its own directory scope: a subshell's assignments never reach
	 * this shell (MIGRATION.md item 101, "a scoped copy for subshells").
	 */
	private nested(stop: ")" | null): void {
		const p = new Parser(this.src, this.opts, new Map(this.vars), this, this.scope(), this.spans);
		p.i = this.i;
		p.list(stop);
		this.i = p.i;
	}

	/** Parse a separate string (a backtick body, a subshell) into the same output, with its own copy of the variables. */
	private sub(text: string): void {
		const p = new Parser(text, this.opts, new Map(this.vars), this, this.scope());
		p.list(null);
	}

	/**
	 * `stop`: `)` closes a subshell or `$( … )` (consumed); `;;` ends a `case` arm at its terminator or
	 * at `esac` (left for caseCompound). Returns the flow of the list's last and-or list (a case arm's
	 * exit). The list has its own sequence and owns the frames it opens; a frame still open at its end
	 * is closed with every exit it could take.
	 */
	list(stop: ")" | ";;" | null): Flow {
		const outer = this.seq;
		const base = this.base;
		this.base = this.frames.length;
		this.seq = newSeq(this.snapshot());
		this.listBody(stop);
		while (this.frames.length > this.base) this.closeFrame();
		const last = this.endAndOr();
		this.seq = outer;
		this.base = base;
		return last;
	}

	private listBody(stop: ")" | ";;" | null): void {
		let prev: SimpleCommand | null = null;
		let piped = false;
		for (;;) {
			this.skipBlanks();
			const c = this.ch;
			if (c === undefined) {
				if (stop) this.failures.push(`unterminated ${stop === ")" ? "( … ) or $( … )" : "case … esac"}`);
				this.readHeredocs();
				return;
			}
			if (stop === ")" && c === stop) {
				this.i++;
				return;
			}
			if (stop === ";;" && (ARM_END(this.src, this.i) !== null || this.atKeyword("esac"))) return;
			if (c === "#") {
				while (this.ch !== undefined && this.ch !== "\n") this.i++;
				continue;
			}
			if (c === "\n") {
				this.i++;
				this.op("\n");
				this.readHeredocs();
				// After `&&`, `||` or `|` a newline continues the list; anywhere else it ends an and-or list.
				const s = this.seq;
				if (s.elem !== null || (s.op === null && s.piped === 0)) this.endAndOr();
				prev = null;
				piped = false;
				continue;
			}
			if (c === "|") {
				const orOp = this.src[this.i + 1] === "|";
				const n = orOp || this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				if (orOp) this.andOr("||");
				else this.pipe();
				piped = !orOp;
				continue;
			}
			if (c === "&" && this.src[this.i + 1] !== ">") {
				const n = this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				if (n === 2) this.andOr("&&");
				else this.async();
				piped = false;
				continue;
			}
			if (c === ";") {
				const n = this.src[this.i + 1] === ";" || this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				this.endAndOr();
				piped = false;
				continue;
			}
			if (c === "(") {
				this.i++;
				this.op("(");
				this.subshell();
				prev = null;
				piped = false;
				continue;
			}
			if (c === ")") {
				this.failures.push("unbalanced )");
				this.i++;
				continue;
			}
			const cmd = this.simple();
			if (cmd) {
				cmd.stdinFrom = piped ? prev : null;
				prev = cmd;
			}
			piped = false;
		}
	}

	/** A `( … )` element (its `(` consumed): parsed in a copy, so every path out of it leaves the state it started in. */
	private subshell(): void {
		const start = this.snapshot();
		this.nested(")");
		this.elementDone(flat(start), start, false);
	}

	/**
	 * One element ran from `start` and left `f`. `bare`: a command of redirects only, which after a
	 * compound closer (`done < f`, `fi > f`, `) > f`) belongs to that compound. Any other element with
	 * no operator before it (`(a) b`, which the shell rejects) is taken as after a `;`.
	 */
	private elementDone(f: Flow, start: State, bare: boolean): void {
		const s = this.seq;
		if (s.elem !== null) {
			if (bare) return;
			this.endAndOr();
		}
		if (s.piped === 0) s.pipeStart = start;
		s.elem = f;
	}

	/** `|`: the element before it ran in a subshell. The next one starts where the pipeline started. */
	private pipe(): void {
		const s = this.seq;
		if (s.elem === null) return;
		s.piped++;
		s.elem = null;
		this.restore(s.pipeStart!);
	}

	/**
	 * End the current pipeline and fold it into the and-or list. A pipeline of several components
	 * leaves the join of its start and its last component's states: zsh, and bash with `lastpipe`, run
	 * the last one in this shell, and `pipefail` decides the status. `!` swaps success and failure.
	 */
	private endPipeline(): void {
		const s = this.seq;
		const e = s.elem;
		const start = s.pipeStart;
		const negate = s.negate;
		const piped = s.piped;
		s.elem = null;
		s.pipeStart = null;
		s.piped = 0;
		s.negate = false;
		if (e === null || start === null) return;
		let f = e;
		if (piped > 0) f = flat(this.join([start, e.ok, e.fail]));
		if (negate) f = { ok: f.fail, fail: f.ok, any: f.any };
		if (s.acc === null || s.op === null) {
			s.aoStart = start;
			s.acc = f;
			s.ops = 0;
		} else if (s.op === "&&") {
			s.acc = { ok: f.ok, fail: this.join([s.acc.fail, f.fail]), any: f.any };
			s.ops++;
		} else {
			s.acc = { ok: this.join([s.acc.ok, f.ok]), fail: f.fail, any: f.any };
			s.ops++;
		}
		s.op = null;
	}

	/** `&&` / `||`: the next pipeline runs from the list's success (`&&`) or failure (`||`) state. */
	private andOr(op: "&&" | "||"): void {
		this.endPipeline();
		const s = this.seq;
		if (s.acc === null) return;
		s.op = op;
		this.restore(op === "&&" ? s.acc.ok : s.acc.fail);
	}

	/** End the current and-or list (`;`, a newline, a keyword, the end of a list) and continue from its status-insensitive state. */
	private endAndOr(): Flow {
		this.endPipeline();
		const s = this.seq;
		if (s.acc !== null) {
			const a = s.acc;
			s.last = s.ops === 0 ? a : { ok: a.ok, fail: a.fail, any: this.join([a.ok, a.fail]) };
			s.acc = null;
			s.aoStart = null;
			s.op = null;
			s.ops = 0;
			this.restore(s.last.any);
		}
		return s.last;
	}

	/** `&`: the list ran asynchronously, in a subshell; what follows starts where the list started. */
	private async(): void {
		this.endPipeline();
		const s = this.seq;
		if (s.acc === null) return;
		const start = s.aoStart!;
		s.last = flat(start);
		s.acc = null;
		s.aoStart = null;
		s.op = null;
		s.ops = 0;
		this.restore(start);
	}

	/** The frame this list owns that is innermost, or null. */
	private topFrame(): Frame | null {
		return this.frames.length > this.base ? this.frames[this.frames.length - 1]! : null;
	}

	private openFrame(kind: Frame["kind"], start: State, exits: State[], body: State | null = null): void {
		this.frames.push({ kind, outer: this.seq, start, exits, phase: kind === "{" ? "body" : "cond", condFail: null, body });
		this.seq = newSeq(start);
	}

	/** Start the next part of `f` (a branch, a body) from `s`. */
	private enter(f: Frame, s: State, phase: Frame["phase"]): void {
		f.phase = phase;
		this.restore(s);
		this.seq = newSeq(s);
	}

	/** The current part of `f` ended: each of its last element's states is a way out. */
	private exitPart(f: Frame): void {
		const last = this.endAndOr();
		f.exits.push(last.ok, last.fail, last.any);
	}

	/**
	 * Close the innermost frame (at its closer, or at the end of the list that owns it): the compound
	 * leaves the join of every exit, whatever its status, as one element of the sequence around it.
	 */
	private closeFrame(): void {
		const f = this.frames.pop()!;
		this.exitPart(f);
		if (f.condFail !== null) f.exits.push(f.condFail);
		const j = this.join(f.exits);
		this.seq = f.outer;
		this.restore(j);
		this.elementDone(flat(j), f.start, false);
	}

	/** Close every frame this list owns down to the innermost one `match` accepts; a closer with none is dropped. */
	private closeTo(match: (f: Frame) => boolean): void {
		for (let k = this.frames.length - 1; k >= this.base; k--) {
			if (!match(this.frames[k]!)) continue;
			while (this.frames.length > k) this.closeFrame();
			return;
		}
	}

	/**
	 * A keyword in command position, recognised on the raw source before the next word is expanded
	 * (PLAN wl-mv4rzy6vmvjeo0 § Frames). `if`: branches start from the condition's success, `elif` and
	 * `else` from its failure, and no branch taken leaves the last condition's failure. `while`/`until`:
	 * the body starts from the condition's success (`until`: failure); the loop is left with no pass
	 * (the other status), after the body, or at a `break`/`continue`. A keyword where it does not belong
	 * is dropped, as before.
	 */
	private keyword(kw: string): void {
		const f = this.topFrame();
		switch (kw) {
			case "!":
				this.seq.negate = !this.seq.negate;
				return;
			case "if":
			case "while":
			case "until":
			case "{":
				this.openFrame(kw, this.snapshot(), []);
				return;
			case "then":
				if (f?.kind === "if" && f.phase === "cond") {
					const c = this.endAndOr();
					f.condFail = c.fail;
					this.enter(f, c.ok, "body");
				}
				return;
			case "elif":
			case "else":
				if (f?.kind === "if" && f.phase === "body" && f.condFail !== null) {
					const from = f.condFail;
					this.exitPart(f);
					f.condFail = null;
					this.enter(f, from, kw === "elif" ? "cond" : "body");
				}
				return;
			case "fi":
				this.closeTo((x) => x.kind === "if");
				return;
			case "do":
				if (f !== null && isLoop(f) && f.phase === "cond") {
					if (f.kind === "for") {
						this.enter(f, f.body!, "body");
						return;
					}
					const c = this.endAndOr();
					f.exits.push(f.kind === "while" ? c.fail : c.ok);
					this.enter(f, f.kind === "while" ? c.ok : c.fail, "body");
				}
				return;
			case "done":
				this.closeTo(isLoop);
				return;
			case "}":
				this.closeTo((x) => x.kind === "{");
				return;
		}
	}

	/**
	 * `for NAME in WORD…` / `select NAME in WORD…` ran (its command is `cmd`, from `start`): open the
	 * loop. The body starts with NAME one of the words' values (`select`: or empty, after a reply out
	 * of range; REPLY unknown), maybe unknown when a word is; `for NAME; do` gives NAME unknown. No
	 * pass at all leaves `start`.
	 */
	private openLoop(cmd: SimpleCommand, start: State): void {
		const [head, name, inWord, ...items] = cmd.words;
		const select = head!.text === "select";
		if (name && !name.opaque && /^[A-Za-z_]\w*$/.test(name.text)) {
			let value: VarValue = null;
			if (inWord && !inWord.opaque && inWord.text === "in") {
				const values: VarValue[] = items.map((w) => (w.candidates ? [...w.candidates] : w.opaque || w.glob ? null : w.text));
				if (select) values.push("");
				value = values.length === 0 ? null : joinValues(values);
			}
			this.setVar(name.text, value);
			if (select) this.setVar("REPLY", null);
		}
		const body = this.snapshot();
		this.restore(start);
		this.openFrame("for", start, [start], body);
	}

	/** `break N` / `continue N` ran in state `s`: a way out of each enclosing loop up to the Nth (every one when N cannot be read). */
	private loopExit(cmd: SimpleCommand, s: State): void {
		const w = cmd.words;
		let k = 0;
		while (k < w.length && ASSIGNMENT.test(w[k]!.text)) k++;
		const head = w[k];
		if (!head || head.opaque || (head.text !== "break" && head.text !== "continue")) return;
		const arg = w[k + 1];
		let n = arg === undefined ? 1 : !arg.opaque && /^[1-9]\d*$/.test(arg.text) ? Number(arg.text) : Number.POSITIVE_INFINITY;
		for (let j = this.frames.length - 1; j >= 0 && n > 0; j--) {
			const f = this.frames[j]!;
			if (!isLoop(f)) continue;
			f.exits.push(s);
			n--;
		}
	}

	/** The state later commands see: the variables assigned so far, the directory and the readonly set. */
	private snapshot(): State {
		return { vars: new Map(this.vars), dir: this.dir, known: this.dirKnown, ro: this.ro };
	}

	/** Make `s` the current state, in place: `vars` is one Map shared with the caller of parseShell. */
	private restore(s: State): void {
		this.vars.clear();
		for (const [k, v] of s.vars) this.vars.set(k, v);
		this.dir = s.dir;
		this.dirKnown = s.known;
		this.ro = s.ro;
	}

	/**
	 * The state after any one of `states` ran, when the gate does not know which: each variable is the
	 * joinValues of its value in every state (a variable absent from a state has the environment's
	 * value there), so one known nowhere is unknown, one with the same known value everywhere keeps it,
	 * and any other is the maybe-unknown array of its known values (a later word that uses it is opaque
	 * with those candidates, so a row judging paths refuses when one is protected). The directory is
	 * known only when every state agrees on it; a name that may be readonly in any state may be in the
	 * join.
	 */
	private join(states: State[]): State {
		const distinct = [...new Set(states)];
		if (distinct.length === 1) return distinct[0]!;
		const names = new Set<string>();
		for (const s of distinct) for (const k of s.vars.keys()) names.add(k);
		const vars = new Map<string, VarValue>();
		for (const name of names) vars.set(name, joinValues(distinct.map((s) => (s.vars.has(name) ? s.vars.get(name)! : (this.opts.env[name] ?? null)))));
		const first = distinct[0]!;
		const known = distinct.every((s) => s.known && s.dir === first.dir);
		let ro = first.ro;
		for (const s of distinct) {
			if (s.ro === ro) continue;
			ro = s.ro === "all" || ro === "all" ? "all" : new Set([...ro, ...s.ro]);
		}
		return { vars, dir: first.dir, known, ro };
	}

	/**
	 * `case WORD in [(]PATTERN[|PATTERN…]) LIST ;; … esac` (POSIX § 2.9.4.3, with bash's `;&` and `;;&`
	 * terminators), the `case` keyword consumed. The subject and the patterns are read and dropped —
	 * after their command substitutions, nested ones included, were parsed as commands of this string
	 * (PR #49 review, B1): the gate does not know which arm the shell takes, so every arm's list is
	 * parsed and judged like any other. Each arm starts from the state at `case` (plus what a `;&` or
	 * `;;&` arm before it left: it may run after that arm), not from what an earlier arm assigned, and
	 * the case is left with the state at `case` (no arm matching) or any arm's exit, the join of its
	 * last element's states (B3: an assignment or `cd` in an arm the shell skips must not decide how a
	 * matching arm's redirect resolves). Returns those exits; the caller joins them. A `case` the
	 * tokenizer cannot read to `esac` (no `in`, a pattern with `(` in it such as an extglob, a pattern
	 * not closed by `)`, no `esac`) is a failure, so the rows refuse it (guard-replay drift triage,
	 * 2026-10-11: the `case` gap was the largest wrong NEW-CATCH group).
	 */
	private caseCompound(entry: State): State[] {
		/** Every way out of the case: no arm matching, and each arm's end. */
		const exits = [entry];
		this.skipBlanks();
		this.word();
		this.skipLines();
		const inEnd = this.keywordEnd("in");
		if (inEnd < 0) {
			this.failures.push("case without `in`");
			return exits;
		}
		this.i = inEnd;
		/** Where the next arm may start: `entry`, joined with the exit of each fall-through arm so far. */
		let flow = entry;
		for (;;) {
			this.skipLines();
			if (this.ch === undefined) {
				this.failures.push("unterminated case … esac");
				return exits;
			}
			const esacEnd = this.keywordEnd("esac");
			if (esacEnd >= 0) {
				this.i = esacEnd;
				if (this.top) this.keywords.push("esac");
				return exits;
			}
			this.restore(flow);
			if (this.ch === "(") this.i++;
			for (;;) {
				this.skipBlanks();
				const start = this.i;
				this.word();
				if (this.i === start) {
					this.failures.push("case pattern the gate cannot read");
					return exits;
				}
				this.skipBlanks();
				if (this.ch === "|") {
					this.i++;
					continue;
				}
				if (this.ch === ")") {
					this.i++;
					break;
				}
				this.failures.push("case pattern not closed by )");
				return exits;
			}
			const last = this.list(";;");
			const exit = this.join([last.ok, last.fail, last.any]);
			exits.push(exit);
			if (this.ch === undefined) return exits; // the list recorded the missing esac
			const end = ARM_END(this.src, this.i);
			if (end !== null) {
				this.op(end);
				this.i += end.length;
				if (end !== ";;") flow = this.join([flow, exit]);
			}
		}
	}

	private simple(): SimpleCommand | null {
		const words: Word[] = [];
		const redirects: Redirect[] = [];
		/** Nothing but keywords recognised on the raw source so far: the next word is in command position. */
		let raw = true;
		/** The command is a `for`/`select` loop's header. */
		let loop = false;
		for (;;) {
			this.skipBlanks();
			const c = this.ch;
			if (c === undefined || c === "\n" || c === ";" || c === "|" || c === ")" || (c === "&" && this.src[this.i + 1] !== ">")) break;
			// `case` in command position, after any keywords (`do case …`, `then case …`, `{ case …`).
			const caseEnd = redirects.length === 0 ? this.keywordEnd("case") : -1;
			if (caseEnd >= 0 && words.every((w) => !w.opaque && !w.glob && KEYWORDS[w.text])) {
				if (this.top) this.keywords.push(...words.map((w) => w.text), "case");
				this.i = caseEnd;
				const entry = this.snapshot();
				const exit = this.join(this.caseCompound(entry));
				this.restore(exit);
				this.elementDone(flat(exit), entry, false);
				return null;
			}
			if (raw && redirects.length === 0) {
				let end = -1;
				const kw = FLOW_KEYWORDS.find((k) => (end = this.keywordEnd(k)) >= 0);
				if (kw !== undefined) {
					if (this.top) this.keywords.push(kw);
					this.i = end;
					this.keyword(kw);
					if (kw === "time") {
						// `time -p`: the option is part of the keyword, and what follows is still in command
						// position (bash 3.2 oracle, sl-cond-fix-r1: `a=git; time -p if false; then a=ls; fi`
						// left `git`). Bash takes no other option: `time --` and a second `-p` are syntax errors.
						this.skipBlanks();
						const optEnd = this.keywordEnd("-p");
						if (optEnd >= 0) this.i = optEnd;
					}
					continue;
				}
				loop = this.atKeyword("for") || this.atKeyword("select");
			}
			if (c === "#") {
				// a `#` at the start of a word begins a comment to end of line
				while (this.ch !== undefined && this.ch !== "\n") this.i++;
				break;
			}
			if (c === "(") {
				// `@(…)`, `!(…)`, `?(…)`, `*(…)`, `+(…)` directly after a word character are extglob
				// patterns once an earlier line ran `shopt -s extglob` (live-tested, bash 3.2.57: the
				// same-line form is a syntax error, the next-line form matches files). The gate does
				// not evaluate extended patterns, so the command is unreadable.
				if ("@!?*+".includes(this.src[this.i - 1] ?? " ")) this.failures.push(`extended glob pattern ${this.src[this.i - 1]}( … )`);
				// `f() { … }`, `a=(1 2)`: the parenthesised part is parsed as commands, never as words.
				// In command position after keywords (`if (a); then`) it is a subshell element, and a
				// keyword may follow it (bash 3.2 oracle, sl-cond-fix-r1: `if (false) then a=ls; fi`,
				// `while (false) do …; done` and `{ (false) }` are compounds).
				this.i++;
				this.op("(");
				if (raw && redirects.length === 0) this.subshell();
				else {
					this.nested(")");
					raw = false;
				}
				continue;
			}
			raw = false;
			if ((c === "<" || c === ">") && this.src[this.i + 1] === "(") {
				// process substitution: a command whose value (a /dev/fd path) is unknown
				this.i += 2;
				this.nested(")");
				words.push({ text: "", opaque: true });
				continue;
			}
			const redir = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|>>|>\||>&|<&|>|<)/.exec(this.src.slice(this.i));
			if (redir) {
				this.i += redir[0].length;
				this.redirect(redir[2]!, redirects);
				continue;
			}
			words.push(...this.word());
		}
		// Drop keywords in command position that were not read on the raw source: a quoted, escaped or
		// expanded spelling (`"time" echo x`) or one after a redirect, all command names to bash, and an
		// Object.prototype name. One that would open, branch or close a frame, or negate a status, has
		// no event here, so the parse fails rather than skip it.
		while (words.length && !words[0]!.opaque && !words[0]!.glob && KEYWORDS[words[0]!.text]) {
			const text = words.shift()!.text;
			if (Object.hasOwn(FRAME_KEYWORDS, text)) this.failures.push(`\`${text}\` where bash does not read it as a keyword (quoted, expanded or after a redirect)`);
			if (this.top) this.keywords.push(text);
		}
		if (words.length === 0 && redirects.length === 0) return null;
		const cmd: SimpleCommand = { words, redirects, dir: this.dir, dirKnown: this.dirKnown, stdinFrom: null, top: this.top };
		const before = this.snapshot();
		const specials = this.effects(cmd);
		this.commands.push(cmd);
		if (loop) this.openLoop(cmd, before);
		else {
			this.loopExit(cmd, before);
			this.elementDone(this.transfer(cmd, before, this.snapshot(), specials), before, words.length === 0);
		}
		return cmd;
	}

	/**
	 * A simple command's flow from `S` (before) and `P` (after its effects), PLAN wl-mv4rzy6vmvjeo0
	 * § Status transfer. `cd` that fails leaves the directory; an assignment-only command and a precise
	 * assignment builtin assign whatever their status; any other assignment builtin may fail before
	 * assigning; any other command may have stored its values (`read`) or not when it fails. A special
	 * name a command assigned is unknown in every state.
	 */
	private transfer(cmd: SimpleCommand, S: State, P: State, specials: string[]): Flow {
		const w = cmd.words;
		let k = 0;
		while (k < w.length && ASSIGNMENT.test(w[k]!.text)) k++;
		if (k === w.length) return flat(P);
		const head = w[k]!;
		if (head.opaque) return flat(P);
		const either = (): State => {
			const j = this.join([S, P]);
			if (j !== S && j !== P) for (const name of specials) j.vars.set(name, null);
			return j;
		};
		switch (head.text) {
			case "cd":
			case "pushd":
			case "popd":
				return { ok: P, fail: S, any: P };
			case "export":
			case "readonly":
			case "declare":
			case "typeset":
			case "local": {
				if (precise(head.text, k === 0 && PLAIN_SOURCE.has(head), w.slice(k + 1), cmd.redirects.length > 0)) return flat(P);
				const j = either();
				return { ok: P, fail: j, any: j };
			}
			default:
				return { ok: P, fail: either(), any: P };
		}
	}

	/**
	 * Assign `name`, by any kind of assignment: a special name becomes unknown; a name that may be
	 * readonly keeps its value before this assignment joined in, since the assignment may have failed.
	 * Returns whether the name is special.
	 */
	private setVar(name: string, value: VarValue): boolean {
		const special = Object.hasOwn(SPECIAL, name) || /^(BASH|COMP_|READLINE_)/.test(name);
		if (special) value = null;
		else if (this.ro === "all" || this.ro.has(name)) value = joinValues([this.vars.has(name) ? this.vars.get(name)! : (this.opts.env[name] ?? null), value]);
		this.vars.set(name, value);
		return special;
	}

	private markReadonly(name: string): void {
		if (this.ro !== "all" && !this.ro.has(name)) this.ro = new Set([...this.ro, name]);
	}

	/** Variable assignments, the readonly set and `cd`: state later commands in the same string see. Returns the special names it assigned. */
	private effects(cmd: SimpleCommand): string[] {
		const w = cmd.words;
		const specials: string[] = [];
		const set = (name: string, value: VarValue): void => {
			if (this.setVar(name, value)) specials.push(name);
		};
		// A word built from a maybe-unknown value carries its candidates, and the value it assigns stays maybe unknown.
		const assign = (word: Word): void => {
			const m = ASSIGNMENT.exec(word.text);
			if (!m) return;
			const name = m[0].slice(0, -1);
			set(name, word.candidates ? word.candidates.map((c) => c.slice(m[0].length)) : word.opaque ? null : word.text.slice(m[0].length));
		};
		let k = 0;
		while (k < w.length && ASSIGNMENT.test(w[k]!.text)) k++;
		if (k === w.length) {
			for (const word of w) assign(word);
			return specials;
		}
		const head = w[k]!;
		if (head.opaque) return specials;
		const rest = w.slice(k + 1);
		switch (head.text) {
			case "export":
			case "declare":
			case "local":
			case "readonly":
			case "typeset": {
				// `readonly`, or an `r` option, marks each name operand readonly once it is assigned: a
				// later operand of the same command naming it fails (r6 F1, per operand, in order).
				const marks = head.text === "readonly" || (head.text !== "export" && rest.some((x) => !x.opaque && /^-[A-Za-z]*r/.test(x.text)));
				// Condition (a) of PLAIN_SOURCE: the head typed as plain text, and no prefix assignment
				// before it (a redirect alone keeps it; review r5 R5-F1).
				const plainHead = k === 0 && PLAIN_SOURCE.has(head);
				for (const word of rest) {
					if (unreadOperand(word, plainHead)) {
						// A word the gate cannot read may be an option (`-r` among them) or any number of
						// `NAME[=value]` words: from here on every name may be readonly, and every name may
						// hold a value the gate does not know (sl-cond-fix-r1, review r1 F1 and F2; review r4).
						this.ro = "all";
						const names = new Set([...this.vars.keys(), ...Object.keys(this.opts.env), "IFS"]);
						for (const name of names) set(name, null);
						continue;
					}
					assign(word);
					const m = /^([A-Za-z_]\w*)(?:=|$)/.exec(word.text);
					if (marks && m) this.markReadonly(m[1]!);
				}
				return specials;
			}
			case "source":
			case ".":
			case "eval":
				// What the sourced or evaluated text marks readonly is not seen here.
				this.ro = "all";
				return specials;
			case "unset":
				for (const word of rest) set(word.text, null);
				return specials;
			case "read":
			case "mapfile":
			case "readarray":
				for (const word of rest) if (!word.text.startsWith("-")) set(word.text, null);
				return specials;
			case "printf":
				// `printf -v NAME fmt …` assigns NAME a value the gate does not compute.
				for (let j = 0; j < rest.length; j++) {
					const t = rest[j]!.text;
					if (t === "-v" && rest[j + 1]) set(rest[j + 1]!.text, null);
					else if (/^-v[A-Za-z_]/.test(t)) set(t.slice(2), null);
				}
				return specials;
			case "cd":
			case "pushd": {
				const arg = rest.find((x) => x.opaque || !x.text.startsWith("-"));
				if (!arg) {
					const home = this.opts.env.HOME;
					if (home) this.dir = home;
					else this.dirKnown = false;
				} else if (arg.opaque || arg.glob || arg.text === "-") this.dirKnown = false;
				else this.dir = resolvePath(this.dir, arg.text);
			}
		}
		return specials;
	}

	private redirect(op: string, into: Redirect[]): void {
		this.skipBlanks();
		if (op === "<<" || op === "<<-") {
			const start = this.i;
			const [delimWord] = this.word();
			const raw = this.src.slice(start, this.i);
			const r: Redirect = { op, target: null, body: null, bodyOpaque: false };
			into.push(r);
			this.pending.push({ redirect: r, delim: delimWord?.text ?? "", expand: !/['"\\]/.test(raw), stripTabs: op === "<<-" });
			return;
		}
		const words = this.word();
		const target = words[0] ?? { text: "", opaque: true };
		if (op === "<<<") {
			into.push({ op, target: null, body: target.text, bodyOpaque: target.opaque });
			return;
		}
		into.push({ op, target, body: null, bodyOpaque: false });
	}

	/** Heredoc bodies start on the line after the operator (called at each newline). */
	private readHeredocs(): void {
		const pending = this.pending;
		this.pending = [];
		for (const h of pending) {
			const lines: string[] = [];
			let found = false;
			while (this.i < this.src.length) {
				const nl = this.src.indexOf("\n", this.i);
				const end = nl < 0 ? this.src.length : nl;
				let line = this.src.slice(this.i, end);
				this.i = nl < 0 ? end : end + 1;
				if (h.stripTabs) line = line.replace(/^\t+/, "");
				if (line === h.delim) {
					found = true;
					break;
				}
				lines.push(line);
			}
			// bash runs an unterminated heredoc to end of input (with a warning): so does the analysis.
			void found;
			const body = lines.join("\n");
			h.redirect.body = body;
			if (h.expand) {
				const p = new Parser(body, this.opts, this.vars, this, this.scope());
				h.redirect.bodyOpaque = p.expansionsOnly();
			}
		}
	}

	/** Walk text as the inside of an unterminated double-quoted string; true if any expansion is unknown. */
	expansionsOnly(): boolean {
		const parts: Part[] = [];
		this.doubleQuoted(parts, false);
		return parts.some((p) => !isSeg(p));
	}

	/** One shell word, brace-expanded and field-split (may yield several words, or none for an empty unquoted expansion). */
	private word(): Word[] {
		const before = this.sawExpansion;
		this.sawExpansion = false;
		const out = this.wordParts();
		if (this.sawExpansion) for (const w of out) w.expanded = true;
		this.sawExpansion = before;
		return out;
	}

	/** Set while reading one word when its spelling carries an expansion or ANSI-C quoting. */
	private sawExpansion = false;

	private wordParts(): Word[] {
		const parts: Part[] = [];
		let quoted = false;
		let braceable = true;
		/** A `{` in the word's own top-level source: outside quotes and outside every `$…` and backquote construct (review r4 R4-F1). */
		let unquotedBrace = false;
		const startLen = this.i;
		for (;;) {
			const c = this.ch;
			if (ENDS_WORD(c)) break;
			if (c === "\\") {
				if (this.src[this.i + 1] === "\n") {
					this.i += 2;
					continue;
				}
				if (this.i + 1 < this.src.length) parts.push({ s: this.src[this.i + 1]!, q: 1 });
				this.i += 2;
				braceable = false;
				continue;
			}
			if (c === "'") {
				const end = this.src.indexOf("'", this.i + 1);
				if (end < 0) {
					this.failures.push("unterminated ' quote");
					this.i = this.src.length;
					parts.push(OPAQUE);
					break;
				}
				parts.push({ s: this.src.slice(this.i + 1, end), q: 1 });
				this.i = end + 1;
				quoted = true;
				braceable = false;
				continue;
			}
			if (c === '"') {
				this.i++;
				parts.push({ s: "", q: 1 });
				if (!this.doubleQuoted(parts, true)) {
					this.failures.push('unterminated " quote');
					parts.push(OPAQUE);
					break;
				}
				quoted = true;
				braceable = false;
				continue;
			}
			if (c === "$" && this.src[this.i + 1] === "'") {
				this.sawExpansion = true;
				this.i += 2;
				parts.push({ s: this.ansiC(), q: 1 });
				quoted = true;
				braceable = false;
				continue;
			}
			if (c === "$" || c === "`") {
				const v = this.expansion(false);
				parts.push(v === OPAQUE ? OPAQUE : Array.isArray(v) ? { alts: v } : { s: v, q: 2 });
				braceable = false;
				continue;
			}
			if (c === "~" && this.i === startLen && (ENDS_WORD(this.src[this.i + 1]) || this.src[this.i + 1] === "/")) {
				const home = this.opts.env.HOME;
				parts.push(home === undefined ? OPAQUE : { s: home, q: 1 });
				this.i++;
				continue;
			}
			if (c === "{") unquotedBrace = true;
			parts.push({ s: c!, q: 0 });
			this.i++;
		}
		const opaque = parts.includes(OPAQUE);
		const segs = parts.filter(isSeg);
		const alts = parts.filter((p): p is Alts => p !== OPAQUE && "alts" in p);
		const unknown = opaque || alts.length > 0;
		const text = segs.map((p) => p.s).join("");
		if (!quoted && !unknown && text === "" && parts.length > 0) return [];
		if (braceable && !quoted && !unknown && /\{[^{}]*,[^{}]*\}/.test(text)) {
			return braceExpand(text).map((t) => ({ text: t, opaque: false, expanded: true, glob: hasGlob([...t].map((ch) => ({ c: ch, active: true }))) }));
		}
		// An assignment word (`x=$y`) is neither field-split nor globbed. Its name is literal: an unknown
		// part ends the lead (`a${n}=x` is not one).
		let lead = "";
		for (const p of parts) {
			if (!isSeg(p) || p.q !== 0) break;
			lead += p.s;
		}
		const assignment = /^[A-Za-z_]\w*=/.test(lead);
		const chars: Ch[] = [];
		let emptyQuoted = false;
		for (const p of segs) {
			if (p.q === 1 && p.s === "") emptyQuoted = true;
			for (const ch of p.s) chars.push({ c: ch, active: p.q !== 1 && !assignment, split: p.q === 2 && !assignment });
		}
		// What an assignment builtin may read of this word (PLAIN_SOURCE, ASSIGNMENT_SOURCE): its raw source
		// is its text, or is a plain identifier and `=` first with no unquoted `{` (reviews r2, r3 and r4).
		const raw = this.src.slice(startLen, this.i);
		const assignmentSource = ASSIGNMENT.test(raw) && !unquotedBrace;
		const opaqueWord = (w: Word): Word[] => {
			if (assignmentSource) ASSIGNMENT_SOURCE.add(w);
			return [w];
		};
		if (opaque) return opaqueWord({ text, opaque: true, glob: hasGlob(chars) });
		if (alts.length > 0) {
			// Every value the word may have: the product of its joined parts, in source order.
			let candidates = [""];
			for (const p of parts) {
				if (isSeg(p)) candidates = candidates.map((c) => c + p.s);
				else candidates = candidates.flatMap((c) => (p as Alts).alts.map((a) => c + a));
				if (candidates.length > MAX_CANDIDATES) {
					this.failures.push(`a word with more than ${MAX_CANDIDATES} possible values (variables a \`case\` assigned)`);
					return opaqueWord({ text, opaque: true, glob: hasGlob(chars) });
				}
			}
			return opaqueWord({ text, opaque: true, glob: hasGlob(chars), candidates });
		}
		const ifsValue = this.vars.get("IFS");
		const ifs: string | null = this.vars.has("IFS") ? (typeof ifsValue === "string" ? ifsValue : null) : DEFAULT_IFS;
		const splittable = chars.some((ch) => ch.split);
		// IFS set to a value the gate does not know: an unquoted expansion splits in unknown places.
		if (splittable && ifs === null) return [{ text, opaque: true, glob: hasGlob(chars) }];
		if (ifs === null || ifs === "" || !chars.some((ch) => ch.split && ifs.includes(ch.c))) {
			const w: Word = { text, opaque: false, glob: hasGlob(chars) };
			if (this.spans) w.span = [startLen, this.i];
			if (raw === text) PLAIN_SOURCE.add(w);
			if (assignmentSource) ASSIGNMENT_SOURCE.add(w);
			return [w];
		}
		return splitFields(chars, ifs, emptyQuoted);
	}

	/** Inside "…" (opening quote consumed). Returns false when the closing quote is missing (and `closing`). */
	private doubleQuoted(parts: Part[], closing: boolean): boolean {
		for (;;) {
			const c = this.ch;
			if (c === undefined) return !closing;
			if (closing && c === '"') {
				this.i++;
				return true;
			}
			if (c === "\\") {
				const n = this.src[this.i + 1];
				if (n === "\n") this.i += 2;
				else if (n !== undefined && "$`\"\\".includes(n)) {
					parts.push({ s: n, q: 1 });
					this.i += 2;
				} else {
					parts.push({ s: "\\", q: 1 });
					this.i++;
				}
				continue;
			}
			if (c === "$" || c === "`") {
				const v = this.expansion(true);
				parts.push(v === OPAQUE ? OPAQUE : Array.isArray(v) ? { alts: v } : { s: v, q: 1 });
				continue;
			}
			parts.push({ s: c, q: 1 });
			this.i++;
		}
	}

	/**
	 * `$…` or a backtick substitution at this.i, `inDq` inside double quotes. Returns the value, the
	 * candidate values of a case-joined variable, or OPAQUE. Every command substitution in it, however
	 * deep, is parsed as commands of this string before the value is given up.
	 */
	private expansion(inDq: boolean): string | string[] | typeof OPAQUE {
		const prevExpansion = this.sawExpansion;
		this.sawExpansion = true;
		const c = this.ch;
		if (c === "`") {
			let j = this.i + 1;
			let body = "";
			while (j < this.src.length && this.src[j] !== "`") {
				if (this.src[j] === "\\" && j + 1 < this.src.length && "`$\\".includes(this.src[j + 1]!)) {
					body += this.src[j + 1];
					j += 2;
				} else body += this.src[j++];
			}
			if (j >= this.src.length) this.failures.push("unterminated ` substitution");
			this.i = Math.min(j + 1, this.src.length);
			this.sub(body);
			return OPAQUE;
		}
		const n = this.src[this.i + 1];
		if (n === "(" && this.src[this.i + 2] === "(") {
			this.i += 3;
			if (!this.expansionBody("))", inDq)) this.failures.push("unterminated $(( … ))");
			return OPAQUE;
		}
		if (n === "(") {
			this.i += 2;
			this.nested(")");
			return OPAQUE;
		}
		if (n === "{") {
			this.i += 2;
			const start = this.i;
			if (!this.expansionBody("}", inDq)) {
				this.failures.push("unterminated ${ … }");
				return OPAQUE;
			}
			const inner = this.src.slice(start, this.i - 1);
			return /^[A-Za-z_]\w*$/.test(inner) ? this.lookup(inner) : OPAQUE;
		}
		if (n !== undefined && /[A-Za-z_]/.test(n)) {
			const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i + 1))!;
			this.i += 1 + m[0].length;
			return this.lookup(m[0]);
		}
		if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
			this.i += 2;
			return OPAQUE;
		}
		this.i++;
		this.sawExpansion = prevExpansion; // a lone `$` is a literal dollar sign
		return "$";
	}

	/**
	 * The body of `${ … }` or `$(( … ))`, from just past its opener to just past `close`. Every command
	 * substitution inside — `$( … )`, backticks, and the same inside a nested `${ … }` or `$(( … ))` —
	 * is parsed as commands of this string: the shell runs it whenever the expansion is evaluated
	 * (PR #49 review, B1; live, 2026-10-11, bash 3.2.57 and zsh: `${x:-$(c)}`, `${x:=$(c)}`,
	 * `` ${x:-`c`} ``, `$(( $(c) ))` and `$(( ${x:-$(c)} ))` all ran `c`). A `"…"` inside hides a
	 * closer and still runs `$( … )`; a `'…'` inside hides both — unless the whole expansion sits in
	 * double quotes (`inDq`), where it is literal text and `$( … )` in it runs (live, same shells);
	 * `\` hides the next character. Bare `(` nests. A bare `{` nests in zsh but not in bash, which ends
	 * `${ … }` at the first unquoted `}` (PR #49 review round 2, N3; live, bash 3.2.57 and zsh -f:
	 * `echo ${x:-{}; printf AFTER >&2; echo }` ran the printf in bash only). The gate does not know
	 * which shell runs the text, so where the two closers differ, the text between them must be plain
	 * word characters, which add no command and no word boundary in either reading (`${x:-{a}}`);
	 * anything else is a failure. The value is not computed (the caller's OPAQUE). Returns false when
	 * the closer is missing; this.i is then at the end of the source.
	 */
	private expansionBody(close: "}" | "))", inDq: boolean): boolean {
		let depth = 0;
		/** Where bash ends a `${ … }`: the first unquoted `}` seen while a bare `{` is open. */
		let bashClose = -1;
		let dq = false;
		while (this.i < this.src.length) {
			const c = this.ch!;
			const n = this.src[this.i + 1];
			if (c === "\\") {
				this.i += 2;
				continue;
			}
			if (c === '"') {
				dq = !dq;
				this.i++;
				continue;
			}
			if (c === "'" && !inDq && !dq) {
				const end = this.src.indexOf("'", this.i + 1);
				if (end < 0) break;
				this.i = end + 1;
				continue;
			}
			if (c === "`" || (c === "$" && (n === "(" || n === "{"))) {
				this.expansion(inDq || dq);
				continue;
			}
			if (close === "}") {
				if (c === "{") depth++;
				else if (c === "}" && !dq) {
					if (depth === 0) {
						this.i++;
						if (bashClose >= 0 && !/^[^\s;&|<>()'"`$\\]*$/.test(this.src.slice(bashClose + 1, this.i - 1))) {
							this.failures.push("a ${ … } with a bare { that bash and zsh end at different places");
						}
						return true;
					}
					if (bashClose < 0) bashClose = this.i;
					depth--;
				}
			} else if (c === "(") depth++;
			else if (c === ")" && !dq) {
				if (depth === 0 && n === ")") {
					this.i += 2;
					return true;
				}
				if (depth > 0) depth--;
			}
			this.i++;
		}
		this.i = this.src.length;
		return false;
	}

	private lookup(name: string): string | string[] | typeof OPAQUE {
		if (this.vars.has(name)) return this.vars.get(name) ?? OPAQUE;
		const v = this.opts.env[name];
		return v === undefined ? OPAQUE : v;
	}

	/** Body of $'…' (opening consumed). */
	private ansiC(): string {
		let out = "";
		while (this.i < this.src.length && this.ch !== "'") {
			const c = this.ch!;
			if (c !== "\\") {
				out += c;
				this.i++;
				continue;
			}
			const n = this.src[this.i + 1] ?? "";
			const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
			if (simple[n] !== undefined) {
				out += simple[n];
				this.i += 2;
				continue;
			}
			const hex = /^x([0-9a-fA-F]{1,2})/.exec(this.src.slice(this.i + 1));
			const oct = /^([0-7]{1,3})/.exec(this.src.slice(this.i + 1));
			const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(this.src.slice(this.i + 1));
			if (hex) {
				out += String.fromCharCode(parseInt(hex[1]!, 16));
				this.i += 1 + hex[0].length;
			} else if (uni) {
				out += String.fromCodePoint(parseInt(uni[1]!, 16));
				this.i += 1 + uni[0].length;
			} else if (oct) {
				out += String.fromCharCode(parseInt(oct[1]!, 8));
				this.i += 1 + oct[0].length;
			} else {
				out += `\\${n}`;
				this.i += 2;
			}
		}
		if (this.ch !== "'") this.failures.push("unterminated $' quote");
		this.i++;
		return out;
	}
}

/** Bash brace expansion of one unquoted word (`-{r,f}` → `-r -f`, `a{1,2}b` → `a1b a2b`). */
export function braceExpand(text: string): string[] {
	const m = /\{([^{}]*,[^{}]*)\}/.exec(text);
	if (!m) return [text];
	const pre = text.slice(0, m.index);
	const post = text.slice(m.index + m[0].length);
	return m[1]!.split(",").flatMap((alt) => braceExpand(pre + alt + post));
}

/** Parse `src` into simple commands. `vars` carries assignments across nested parses of one command. */
export function parseShell(src: string, opts: ParseOptions, vars: Map<string, VarValue> = new Map()): ParseResult {
	const p = new Parser(src.replace(/\r\n?/g, "\n"), opts, vars, undefined, undefined, opts.spans === true);
	p.list(null);
	return { commands: p.commands, failures: p.failures, ops: p.ops, keywords: p.keywords };
}

/** Single-quote a value for re-parsing (`'it'\''s'`). */
export function shellQuote(s: string): string {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
