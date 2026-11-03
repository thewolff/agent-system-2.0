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
	 * Values an opaque word may take that the gate knows: a variable a `case` assigned in some arm
	 * (PR #49 review, B3), used after `esac` or in a later arm. The gate does not know which arm ran,
	 * so the word is opaque; a row judging paths refuses when any candidate is a protected path. The
	 * list is complete only when the variable was known on every path through the `case`; on an
	 * unknown path it is unknown, and the word is opaque either way.
	 */
	candidates?: string[];
	/**
	 * Values with an unknown middle (item 102): set on an opaque word whose known parts may still pin
	 * its value (`"/not-real/$U"`, `"$U/ledger.db"`, `"$f$U"` after a `case` set `f`). Each is the known
	 * text before the word's first unknown part and after its last; the known text between two unknown
	 * parts is dropped, so `head + <anything> + tail` covers every value the word can take. A fragment
	 * is never a literal: it does not clear `opaque` and grants nothing; a row judging paths refuses
	 * when a fragment may be a protected path. A fragment whose head and tail are both empty is not kept.
	 */
	fragments?: Fragment[];
	/**
	 * Set on an opaque word: true when some unknown part of it is unquoted, so the shell may split it
	 * into several words (or none) when it runs, or when a quoted part expands to several words (`"$@"`,
	 * `"${a[@]}"`); false when every unknown part sits inside double quotes and the word stays one word.
	 * Absent (on a known word, or a word built outside the parser) reads as true for a caller asking
	 * whether an unknown word may split (PLAN wl-mvqwn80onq9hq8 D2a).
	 */
	splits?: boolean;
}

/** One value a word may take that has an unknown middle: the known text before its first unknown part and after its last. */
export interface Fragment {
	head: string;
	tail: string;
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
	/** The file descriptor number written before the operator (`2` in `2>&1`); absent when none was. */
	fd?: string;
}

export interface SimpleCommand {
	words: Word[];
	redirects: Redirect[];
	/** Directory the command runs in (after earlier `cd`s). */
	dir: string;
	/** False once a `cd` to an unknown directory ran before this command. */
	dirKnown: boolean;
	/**
	 * The `cd`/`pushd` operand words that set `dir`, in order (every arm's, after a `case`): what the
	 * directory was spelled from, for a caller that trusts `dir` only for a literal spelling. A `cd`
	 * with no operand adds a word holding HOME with no span. Empty while `dir` is the start directory.
	 */
	hops: Word[];
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
	/** The same keywords, and `case`, at every depth (inside `( … )`, `$( … )`, backticks and heredocs too), in source order. */
	compounds: string[];
}

export interface ParseOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	/** Record each word's `span` (see Word.span). Only the top-level parse of a command string the caller holds opts in. */
	spans?: boolean;
}

/**
 * A variable's value in this command string: known; the values known on some paths through a `case`
 * (others may be unknown), each a string or a Fragment (a value with an unknown middle, item 102); or
 * unknown.
 */
export type VarValue = string | Array<string | Fragment> | null;

const OPAQUE = Symbol("opaque");
/** A piece of a word: `q` 0 = unquoted literal, 1 = quoted or escaped, 2 = unquoted expansion result. */
interface Seg {
	s: string;
	q: 0 | 1 | 2;
}
/** A piece whose value is one of `alts` (a case-joined variable, or one assigned a value with an unknown middle). */
interface Alts {
	alts: Array<string | Fragment>;
}
type Part = Seg | Alts | typeof OPAQUE;
const isSeg = (p: Part): p is Seg => p !== OPAQUE && "s" in p;
/** More candidate values than one word is followed through (a product of joined variables). */
const MAX_CANDIDATES = 64;
/** One key per fragment value, for deduplication. */
const fragmentKey = (f: Fragment): string => `${f.head}\0${f.tail}`;
/** One value of a word being read (wordParts): with no `hole`, `head` is the whole value; with one, `head` is the known text before the first unknown part and `tail` the known text after the last. */
interface Pattern {
	head: string;
	tail: string;
	hole: boolean;
}
/** `patterns` with repeated values that have a hole dropped; values without one are kept as they are (the candidate product). */
function dedupeHoles(patterns: Pattern[]): Pattern[] {
	const seen = new Set<string>();
	return patterns.filter((x) => {
		if (!x.hole) return true;
		const key = fragmentKey(x);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * `w` with `lead` (an option or `NAME=` prefix the caller has read off its text) cut from the front of
 * its value: from `text`, from each candidate, and from each fragment head that starts with it (item
 * 102). A fragment whose head does not start with `lead` keeps only its tail (head `""`: the lead may
 * end inside the unknown part), and one left with neither head nor tail is dropped. A candidate that
 * does not start with `lead` is kept whole.
 */
export function dropLead(w: Word, lead: string): Word {
	const cut = (s: string): string => (s.startsWith(lead) ? s.slice(lead.length) : s);
	const { candidates, fragments, ...rest } = w;
	const out: Word = { ...rest, text: cut(w.text) };
	if (candidates) out.candidates = candidates.map(cut);
	const kept = (fragments ?? []).map((f) => ({ head: f.head.startsWith(lead) ? f.head.slice(lead.length) : "", tail: f.tail })).filter((f) => f.head !== "" || f.tail !== "");
	if (kept.length > 0) out.fragments = kept;
	return out;
}

/**
 * The value an assignment word `NAME=…` gives NAME (`lead` is `NAME=`): its text; the values it may
 * take, the `case` candidates and the fragments with an unknown middle (item 102), less the lead; or
 * unknown, for an opaque word with neither, or a fragment whose known head does not reach past the lead.
 */
function assignedValue(word: Word, lead: string): VarValue {
	if (!word.candidates && !word.fragments) return word.opaque ? null : word.text.slice(lead.length);
	if (word.fragments?.some((f) => !f.head.startsWith(lead))) return null;
	const v = dropLead(word, lead);
	const values: Array<string | Fragment> = [...(v.candidates ?? []), ...(v.fragments ?? [])];
	return values.length === 0 ? null : values;
}

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

interface PendingHeredoc {
	redirect: Redirect;
	delim: string;
	expand: boolean;
	stripTabs: boolean;
}

/** Where later commands run: the directory, whether it is known, and the `cd` words that set it (SimpleCommand.hops). */
interface DirState {
	dir: string;
	known: boolean;
	hops: Word[];
}

/** The parser's definite state at one point of the source (see Parser.snapshot). */
interface State extends DirState {
	vars: Map<string, VarValue>;
}

/** Keywords that open a compound command whose body is a list of its own (`for` and `select` arrive as a command head). */
const OPENS_COMPOUND: Record<string, true> = { "{": true, if: true, while: true, until: true, for: true, select: true };
/** Keywords that start a new list inside an open compound. */
const STARTS_LIST: Record<string, true> = { then: true, else: true, elif: true, do: true };
/** Keywords that close a compound command. */
const CLOSES_COMPOUND: Record<string, true> = { "}": true, fi: true, done: true };

class Parser {
	i = 0;
	readonly commands: SimpleCommand[];
	readonly failures: string[];
	readonly compounds: string[];
	readonly ops: string[] = [];
	readonly keywords: string[] = [];
	/** This parser reads the top level of the source (no sink: not a nested or sub parse). */
	readonly top: boolean;
	dir: string;
	dirKnown = true;
	/** The `cd` words that set `dir` (SimpleCommand.hops); a new array on every change, so a snapshot never aliases it. */
	hops: Word[] = [];
	/** The compound keywords the last `simple()` read in command position (dropped keywords, then a `for`/`select` head), for list(). */
	private compound: string[] = [];
	private pending: PendingHeredoc[] = [];

	constructor(
		readonly src: string,
		readonly opts: ParseOptions,
		readonly vars: Map<string, VarValue>,
		sink?: { commands: SimpleCommand[]; failures: string[]; compounds: string[] },
		dir?: DirState,
		/** Record word spans: set by parseShell from `opts.spans`, kept by `nested`, never by a `sub` or heredoc parser. */
		readonly spans = false,
	) {
		this.top = sink === undefined;
		this.commands = sink?.commands ?? [];
		this.failures = sink?.failures ?? [];
		this.compounds = sink?.compounds ?? [];
		this.dir = dir?.dir ?? opts.cwd;
		this.dirKnown = dir?.known ?? true;
		this.hops = dir?.hops ?? [];
	}

	/** The directory state now, for a nested parser or a list boundary. */
	private dirState(): DirState {
		return { dir: this.dir, known: this.dirKnown, hops: this.hops };
	}

	private setDir(s: DirState): void {
		this.dir = s.dir;
		this.dirKnown = s.known;
		this.hops = s.hops;
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

	/** An unquoted `kw` starts at `i` and ends there as a word (`esac;` yes, `esacx` and `"esac"` no). */
	private atKeyword(kw: string): boolean {
		return this.src.startsWith(kw, this.i) && ENDS_WORD(this.src[this.i + kw.length]);
	}

	/** A nested parser over the same source (subshell, `$(…)`), sharing output, with its own directory scope. */
	private nested(stop: ")" | null): void {
		const p = new Parser(this.src, this.opts, this.vars, this, this.dirState(), this.spans);
		p.i = this.i;
		p.list(stop);
		this.i = p.i;
	}

	/** Parse a separate string (backtick body, heredoc, `eval`) into the same output. */
	private sub(text: string): void {
		const p = new Parser(text, this.opts, this.vars, this, this.dirState());
		p.list(null);
	}

	/**
	 * `stop`: `)` closes a subshell or `$( … )` (consumed); `;;` ends a `case` arm at its terminator or at `esac` (left for caseCompound).
	 * An and-or list ended by `&` runs in a subshell (bash(1), Lists: "the shell executes the command in the background in a
	 * subshell"), so the commands after it start from the directory its first command started from (PLAN wl-mvqwn80onq9hq8 D2b;
	 * msg-mvqwye908wldp2: `cd x && rm r0 & ls` runs `ls` where the call started). `starts` holds that directory per open
	 * compound command (`{`, `if`, `while`, `until`, `for`, `select`): a compound is one command of the list around it, so
	 * `{ cd x; } &` returns to the directory before the `{`. Variables keep today's reading.
	 */
	list(stop: ")" | ";;" | null): void {
		let prev: SimpleCommand | null = null;
		let piped = false;
		const starts: DirState[] = [this.dirState()];
		const boundary = (): void => {
			starts[starts.length - 1] = this.dirState();
		};
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
				prev = null;
				piped = false;
				boundary();
				continue;
			}
			if (c === "|") {
				const orOp = this.src[this.i + 1] === "|";
				const n = orOp || this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				piped = !orOp;
				continue;
			}
			if (c === "&" && this.src[this.i + 1] !== ">") {
				const n = this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				piped = false;
				if (n === 1) {
					this.setDir(starts[starts.length - 1]!);
					boundary();
				}
				continue;
			}
			if (c === ";") {
				const n = this.src[this.i + 1] === ";" || this.src[this.i + 1] === "&" ? 2 : 1;
				this.op(this.src.slice(this.i, this.i + n));
				this.i += n;
				piped = false;
				boundary();
				continue;
			}
			if (c === "(") {
				this.i++;
				this.op("(");
				this.nested(")");
				prev = null;
				piped = false;
				continue;
			}
			if (c === ")") {
				this.failures.push("unbalanced )");
				this.i++;
				continue;
			}
			const before = this.dirState();
			const cmd = this.simple();
			if (cmd) {
				cmd.stdinFrom = piped ? prev : null;
				prev = cmd;
			}
			piped = false;
			// Keywords sit before the command they lead, so a list or compound they start starts before its effects.
			for (const kw of this.compound) {
				if (CLOSES_COMPOUND[kw]) {
					if (starts.length > 1) starts.pop();
				} else if (STARTS_LIST[kw]) starts[starts.length - 1] = before;
				else if (OPENS_COMPOUND[kw]) starts.push(before);
			}
			this.compound = [];
		}
	}

	/** The definite state later commands see: the variables assigned so far and the directory. */
	private snapshot(): State {
		return { vars: new Map(this.vars), ...this.dirState() };
	}

	/** Make `s` the current state, in place: `vars` is one Map shared with nested parsers and the caller. */
	private restore(s: State): void {
		this.vars.clear();
		for (const [k, v] of s.vars) this.vars.set(k, v);
		this.setDir(s);
	}

	/**
	 * The state after any one of `states` ran, when the gate does not know which: a variable with the
	 * same known value in every state keeps it; one with several known values, or known in some states
	 * and not others, keeps the known ones (a later word that uses it is opaque with those candidates,
	 * so a row judging paths refuses when one is protected); one known nowhere is unknown. A value with
	 * an unknown middle (a Fragment, item 102) is kept with the known ones, deduplicated by head and
	 * tail, and is never a definite value. A variable absent from a state has the environment's value
	 * there. The directory is known only when every state agrees on it.
	 */
	private join(states: State[]): State {
		const names = new Set<string>();
		for (const s of states) for (const k of s.vars.keys()) names.add(k);
		const vars = new Map<string, VarValue>();
		for (const name of names) {
			const values = new Set<string>();
			const fragments = new Map<string, Fragment>();
			let unknown = false;
			for (const s of states) {
				const v = s.vars.has(name) ? s.vars.get(name)! : (this.opts.env[name] ?? null);
				if (v === null) unknown = true;
				else if (typeof v === "string") values.add(v);
				else
					for (const x of v) {
						if (typeof x === "string") values.add(x);
						else fragments.set(fragmentKey(x), x);
					}
			}
			const known: Array<string | Fragment> = [...values, ...fragments.values()];
			vars.set(name, known.length === 0 ? null : !unknown && fragments.size === 0 && values.size === 1 ? [...values][0]! : known);
		}
		const first = states[0]!;
		const known = states.every((s) => s.known && s.dir === first.dir);
		// Every arm's `cd` words, each once: a caller trusting `dir` by its spelling reads them all.
		const hops = [...new Set(states.flatMap((s) => s.hops))];
		return { vars, dir: first.dir, known, hops };
	}

	/**
	 * `case WORD in [(]PATTERN[|PATTERN…]) LIST ;; … esac` (POSIX § 2.9.4.3, with bash's `;&` and `;;&`
	 * terminators), the `case` keyword consumed. The subject and the patterns are read and dropped —
	 * after their command substitutions, nested ones included, were parsed as commands of this string
	 * (PR #49 review, B1): the gate does not know which arm the shell takes, so every arm's list is
	 * parsed and judged like any other. Each arm starts from the state at `case` (plus what a `;&` or
	 * `;;&` arm before it left: it may run after that arm), not from what an earlier arm assigned, and
	 * after `esac` the states of every arm and of no arm matching are joined (B3: an assignment or
	 * `cd` in an arm the shell skips must not decide how a matching arm's redirect resolves). A `case`
	 * the tokenizer cannot read to `esac` (no `in`, a pattern with `(` in it such as an extglob, a
	 * pattern not closed by `)`, no `esac`) is a failure, so the rows refuse it (guard-replay drift
	 * triage, 2026-10-11: the `case` gap was the largest wrong NEW-CATCH group).
	 */
	private caseCompound(): void {
		this.skipBlanks();
		this.word();
		this.skipLines();
		if (!this.atKeyword("in")) {
			this.failures.push("case without `in`");
			return;
		}
		this.i += 2;
		const entry = this.snapshot();
		/** Where the next arm may start: `entry`, joined with the exit of each fall-through arm so far. */
		let flow = entry;
		/** Every way out of the case: no arm matching, and each arm's end. */
		const exits = [entry];
		for (;;) {
			this.skipLines();
			if (this.ch === undefined) {
				this.failures.push("unterminated case … esac");
				return;
			}
			if (this.atKeyword("esac")) {
				this.i += 4;
				if (this.top) this.keywords.push("esac");
				this.compounds.push("esac");
				this.restore(this.join(exits));
				return;
			}
			this.restore(flow);
			if (this.ch === "(") this.i++;
			for (;;) {
				this.skipBlanks();
				const start = this.i;
				this.word();
				if (this.i === start) {
					this.failures.push("case pattern the gate cannot read");
					return;
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
				return;
			}
			this.list(";;");
			if (this.ch === undefined) return; // the list recorded the missing esac
			const exit = this.snapshot();
			exits.push(exit);
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
		for (;;) {
			this.skipBlanks();
			const c = this.ch;
			if (c === undefined || c === "\n" || c === ";" || c === "|" || c === ")" || (c === "&" && this.src[this.i + 1] !== ">")) break;
			// `case` in command position, after any keywords (`do case …`, `then case …`, `{ case …`).
			if (redirects.length === 0 && this.atKeyword("case") && words.every((w) => !w.opaque && !w.glob && KEYWORDS[w.text])) {
				if (this.top) this.keywords.push(...words.map((w) => w.text), "case");
				this.compounds.push(...words.map((w) => w.text), "case");
				this.i += 4;
				this.caseCompound();
				// The arms' own lists reset `compound`; the keywords before `case` lead it.
				this.compound = words.map((w) => w.text);
				return null;
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
				this.i++;
				this.op("(");
				this.nested(")");
				continue;
			}
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
				this.redirect(redir[2]!, redirects, redir[1] || undefined);
				continue;
			}
			words.push(...this.word());
		}
		// Drop keywords in command position (`if git reset --hard; then`, `{ … }`).
		const compound: string[] = [];
		while (words.length && !words[0]!.opaque && !words[0]!.glob && KEYWORDS[words[0]!.text]) {
			if (this.top) this.keywords.push(words[0]!.text);
			this.compounds.push(words[0]!.text);
			compound.push(words[0]!.text);
			words.shift();
		}
		const head = words[0];
		if (head && !head.opaque && !head.glob && !head.expanded && (head.text === "for" || head.text === "select")) compound.push(head.text);
		this.compound = compound;
		if (words.length === 0 && redirects.length === 0) return null;
		const cmd: SimpleCommand = { words, redirects, dir: this.dir, dirKnown: this.dirKnown, hops: this.hops, stdinFrom: null, top: this.top };
		this.effects(cmd);
		this.commands.push(cmd);
		return cmd;
	}

	/** Variable assignments and `cd`: state later commands in the same string see. */
	private effects(cmd: SimpleCommand): void {
		const w = cmd.words;
		const assign = (word: Word): void => {
			const m = /^([A-Za-z_]\w*)=/.exec(word.text);
			if (!m) return;
			this.vars.set(m[1]!, assignedValue(word, m[0]));
		};
		let k = 0;
		while (k < w.length && /^[A-Za-z_]\w*=/.test(w[k]!.text)) k++;
		if (k === w.length) {
			for (const word of w) assign(word);
			return;
		}
		const head = w[k]!;
		if (head.opaque) return;
		const rest = w.slice(k + 1);
		switch (head.text) {
			case "export":
			case "declare":
			case "local":
			case "readonly":
			case "typeset":
				for (const word of rest) assign(word);
				return;
			case "unset":
				for (const word of rest) this.vars.set(word.text, null);
				return;
			case "read":
			case "mapfile":
			case "readarray":
				for (const word of rest) if (!word.text.startsWith("-")) this.vars.set(word.text, null);
				return;
			case "printf":
				// `printf -v NAME fmt …` assigns NAME a value the gate does not compute.
				for (let j = 0; j < rest.length; j++) {
					const t = rest[j]!.text;
					if (t === "-v" && rest[j + 1]) this.vars.set(rest[j + 1]!.text, null);
					else if (/^-v[A-Za-z_]/.test(t)) this.vars.set(t.slice(2), null);
				}
				return;
			case "cd":
			case "pushd": {
				const arg = rest.find((x) => x.opaque || !x.text.startsWith("-"));
				if (!arg) {
					const home = this.opts.env.HOME;
					if (home) {
						this.dir = home;
						this.hops = [...this.hops, { text: home, opaque: false, expanded: true }];
					} else this.dirKnown = false;
				} else if (arg.opaque || arg.glob || arg.text === "-") this.dirKnown = false;
				else {
					this.dir = resolvePath(this.dir, arg.text);
					this.hops = [...this.hops, arg];
				}
			}
		}
	}

	private redirect(op: string, into: Redirect[], fd?: string): void {
		this.skipBlanks();
		if (op === "<<" || op === "<<-") {
			const start = this.i;
			const [delimWord] = this.word();
			const raw = this.src.slice(start, this.i);
			const r: Redirect = { op, target: null, body: null, bodyOpaque: false, ...(fd ? { fd } : {}) };
			into.push(r);
			this.pending.push({ redirect: r, delim: delimWord?.text ?? "", expand: !/['"\\]/.test(raw), stripTabs: op === "<<-" });
			return;
		}
		const words = this.word();
		const target = words[0] ?? { text: "", opaque: true };
		if (op === "<<<") {
			into.push({ op, target: null, body: target.text, bodyOpaque: target.opaque, ...(fd ? { fd } : {}) });
			return;
		}
		into.push({ op, target, body: null, bodyOpaque: false, ...(fd ? { fd } : {}) });
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
				const p = new Parser(body, this.opts, this.vars, this, this.dirState());
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

	/** Set by expansion() when an expansion may give several words even inside double quotes (`"$@"`, `"${a[@]}"`); read and reset around each `"…"` by wordParts. */
	private multiField = false;

	private wordParts(): Word[] {
		const parts: Part[] = [];
		let quoted = false;
		let braceable = true;
		/** An unquoted unknown part, or a quoted expansion to several words (Word.splits). */
		let splits = false;
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
					splits = true;
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
				const outerMulti = this.multiField;
				this.multiField = false;
				const closed = this.doubleQuoted(parts, true);
				if (this.multiField) splits = true;
				this.multiField = outerMulti;
				if (!closed) {
					this.failures.push('unterminated " quote');
					parts.push(OPAQUE);
					splits = true;
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
				if (typeof v !== "string") splits = true;
				parts.push(v === OPAQUE ? OPAQUE : Array.isArray(v) ? { alts: v } : { s: v, q: 2 });
				braceable = false;
				continue;
			}
			if (c === "~" && this.i === startLen && (ENDS_WORD(this.src[this.i + 1]) || this.src[this.i + 1] === "/")) {
				const home = this.opts.env.HOME;
				parts.push(home === undefined ? OPAQUE : { s: home, q: 1 });
				if (home === undefined) splits = true;
				this.i++;
				continue;
			}
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
		// An assignment word (`x=$y`) is neither field-split nor globbed.
		let lead = "";
		for (const p of segs) {
			if (p.q !== 0) break;
			lead += p.s;
		}
		const assignment = /^[A-Za-z_]\w*=/.test(lead);
		const chars: Ch[] = [];
		let emptyQuoted = false;
		for (const p of segs) {
			if (p.q === 1 && p.s === "") emptyQuoted = true;
			for (const ch of p.s) chars.push({ c: ch, active: p.q !== 1 && !assignment, split: p.q === 2 && !assignment });
		}
		if (unknown) {
			// Every value the word may have, one pass over its parts in source order (item 102). A pattern
			// with no unknown part is a candidate (the product of its joined parts); one with an unknown part
			// (a hole) keeps the known text before its first hole and after its last, and is a fragment. The
			// known text between two holes is dropped: `head + <anything> + tail` still covers the value.
			const glob = hasGlob(chars);
			let patterns: Pattern[] = [{ head: "", tail: "", hole: false }];
			const append = (x: Pattern, s: string): Pattern => ({ head: x.hole ? x.head : x.head + s, tail: x.tail + s, hole: x.hole });
			for (const p of parts) {
				if (p === OPAQUE) patterns = patterns.map((x) => ({ head: x.head, tail: "", hole: true }));
				else if (isSeg(p)) patterns = patterns.map((x) => append(x, p.s));
				else patterns = patterns.flatMap((x) => p.alts.map((a) => (typeof a === "string" ? append(x, a) : { head: x.hole ? x.head : x.head + a.head, tail: a.tail, hole: true })));
				patterns = dedupeHoles(patterns);
				if (patterns.length > MAX_CANDIDATES) {
					this.failures.push(`a word with more than ${MAX_CANDIDATES} possible values (variables a \`case\` assigned)`);
					return [{ text, opaque: true, glob, splits: true }];
				}
			}
			// A known unquoted expansion beside the unknown part splits too: the word is not field-split here.
			const w: Word = { text, opaque: true, glob, splits: splits || chars.some((ch) => ch.split) };
			const candidates = patterns.filter((x) => !x.hole).map((x) => x.head);
			const fragments = patterns.filter((x) => x.hole && (x.head !== "" || x.tail !== "")).map((x) => ({ head: x.head, tail: x.tail }));
			if (candidates.length > 0) w.candidates = candidates;
			if (fragments.length > 0) w.fragments = fragments;
			return [w];
		}
		const ifsValue = this.vars.get("IFS");
		const ifs: string | null = this.vars.has("IFS") ? (typeof ifsValue === "string" ? ifsValue : null) : DEFAULT_IFS;
		const splittable = chars.some((ch) => ch.split);
		// IFS set to a value the gate does not know: an unquoted expansion splits in unknown places.
		if (splittable && ifs === null) return [{ text, opaque: true, glob: hasGlob(chars), splits: true }];
		if (ifs === null || ifs === "" || !chars.some((ch) => ch.split && ifs.includes(ch.c))) {
			const w: Word = { text, opaque: false, glob: hasGlob(chars) };
			if (this.spans) w.span = [startLen, this.i];
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
	 * candidate values of a case-joined variable (each a string or a Fragment), or OPAQUE. Every command
	 * substitution in it, however deep, is parsed as commands of this string before the value is given up.
	 */
	private expansion(inDq: boolean): string | Array<string | Fragment> | typeof OPAQUE {
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
			// `${a[@]}`, `${@:2}`, `${!p@}`: several words even inside double quotes.
			if (inner.includes("@")) this.multiField = true;
			return /^[A-Za-z_]\w*$/.test(inner) ? this.lookup(inner) : OPAQUE;
		}
		if (n !== undefined && /[A-Za-z_]/.test(n)) {
			const m = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i + 1))!;
			this.i += 1 + m[0].length;
			return this.lookup(m[0]);
		}
		if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
			if (n === "@") this.multiField = true;
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

	private lookup(name: string): string | Array<string | Fragment> | typeof OPAQUE {
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
	return { commands: p.commands, failures: p.failures, ops: p.ops, keywords: p.keywords, compounds: p.compounds };
}

/** Single-quote a value for re-parsing (`'it'\''s'`). */
export function shellQuote(s: string): string {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
