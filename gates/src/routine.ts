// The routine classifier (PLAN wl-mvqwn80onq9hq8 D2, D2a, D2b): which row 6 reserved refusals of a
// lane's or hand's bash call are routine enough to apply without asking Jo. `routineVerdict` is pure
// over the call and the files it reads (no ledger, no network, no state outside the call); the gate
// runs it in a worker under a deadline (routine-worker.ts) and asks Jo on any `{ ask }`.
//
// Case 1, rule `read-only`: the whole call reads. Row 6 with `tolerateUnread` lets it through, every
// simple command at every depth is on an allow-list (plain readers, git read forms, gh read
// subcommands and GET-only `gh api`), and every redirect goes to /dev/null or duplicates an fd. A call
// whose accepted commands include `gh` gets the network; then no other command may be git, and gh's
// stderr must reach the tool result unaltered.
//
// Case 2, rule `scratch` or `worktree`: row 6 with `scratchRelative` (and the workload's worktree) lets
// the call through because its rm and git discards are confined to one root: the lane's own scratch
// root, or its own worktree (never the root itself or a `.git` component). One call never mixes roots.
import { basename, resolve } from "node:path";
import { bashCommand, type Exec, expandShell, gitCall } from "./exec";
import { nowReserved, reservedAction, reservedVerdict } from "./rows/r06-reserved";
import { currentBranch } from "./rows/r09-protected-edit";
import { ownScratchRoot } from "./scratch";
import { type ParseResult, parseShell, type Redirect, type Word } from "./shell-parse";
import { type CallContext, type ToolCall, WORKLOAD_ENV } from "./types";

/** What the classifier decided: a rule the call auto-applies under, or why it asks Jo. */
export type RoutineVerdict =
	| {
			rule: "read-only";
			detail: string;
			/** True only when an accepted command is `gh` (D2a (iv)). */
			network: boolean;
			/** The plain readers the call names, for the network profile's exec allow-list (D4). */
			readers: string[];
	  }
	| {
			rule: "scratch" | "worktree";
			detail: string;
			network: false;
			/** The root the call is confined to: the own scratch root, or the own worktree. */
			root: string;
	  }
	| { ask: string };

/** The tool-call context, and the workload's `worktree:` control entry (absent for a hand or a workload without one). */
export interface RoutineContext extends CallContext {
	worktreeRoot?: string;
}

/** Longest command and most simple commands the classifier reads (D2); anything larger asks. */
export const MAX_COMMAND_CHARS = 4096;
export const MAX_SIMPLE_COMMANDS = 64;

/**
 * The classifier over one tool call: a rule when the call is routine, else `{ ask }` naming why. It
 * asks for any role but lane or hand, any tool but bash, a call with no own scratch root, a call row 6
 * does not refuse as a reserved action, a NOW-reserved action, an oversized command, a parse with
 * failures, a command the expander cannot see (`blind`) or inline interpreter code, the bash tool's
 * `env`, and any exception (`classifier error: <message>`).
 */
export function routineVerdict(call: ToolCall, ctx: RoutineContext): RoutineVerdict {
	try {
		return classify(call, ctx);
	} catch (err) {
		return { ask: `classifier error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function classify(call: ToolCall, ctx: RoutineContext): RoutineVerdict {
	if (ctx.role !== "lane" && ctx.role !== "hand") return { ask: `the call is from a ${ctx.role}; only a lane's or a hand's calls auto-apply` };
	if (call.toolName !== "bash") return { ask: `the ${call.toolName} tool; only bash calls auto-apply` };
	const scratchRoot = ownScratchRoot(ctx.env);
	if (scratchRoot === null) return { ask: "the session has no own scratch root (no bound workload, or AS2_SCRATCH names another path)" };
	const base = { toolName: call.toolName, input: call.input };
	const refusal = reservedVerdict(base, ctx).refusal;
	const action = reservedAction(refusal);
	if (action === null) return { ask: refusal ? "row 6 refuses the call for a reason that is not a reserved action" : "row 6 does not refuse the call" };
	if (nowReserved(action)) return { ask: `a NOW-reserved action (${action})` };
	const { input } = call;
	if (input.env !== undefined) return { ask: "the bash tool's env is set" };
	const cmd = bashCommand(input);
	if (cmd.length > MAX_COMMAND_CHARS) return { ask: `the command is longer than ${MAX_COMMAND_CHARS} characters` };
	const cwd = typeof input.cwd === "string" ? resolve(ctx.cwd, input.cwd) : ctx.cwd;
	const parse = parseShell(cmd, { cwd, env: ctx.env });
	if (parse.failures.length > 0) return { ask: `the command does not parse (${parse.failures[0]})` };
	const x = expandShell(cmd, cwd, ctx.env);
	if (parse.commands.length > MAX_SIMPLE_COMMANDS || x.commands.length > MAX_SIMPLE_COMMANDS) return { ask: `the command has more than ${MAX_SIMPLE_COMMANDS} simple commands` };
	if (x.blind.length > 0) return { ask: `part of the command is not visible to the gate (${x.blind[0]})` };
	if (x.code.length > 0) return { ask: `the command runs inline ${x.code[0]!.lang} code` };

	const readOnly = caseReadOnly(base, ctx, cmd, parse, x.commands);
	if (!("ask" in readOnly)) return readOnly;
	const confined = caseConfined(base, ctx, scratchRoot, x.commands);
	if (!("ask" in confined)) return confined;
	return { ask: `not read-only: ${readOnly.ask}; not confined: ${confined.ask}` };
}

// ---------------------------------------------------------------------------------------------
// Case 1: read-only (D2a)

/** Compound keywords a read-only call may hold: braces, and the `do … done` of a `for` loop (its header is checked as a command). */
const READ_ONLY_KEYWORDS: Record<string, true> = { "{": true, "}": true, do: true, done: true };

/** A table's own entry for `key`, never one inherited from Object.prototype (`constructor`, `toString`). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

function caseReadOnly(call: ToolCall, ctx: CallContext, cmd: string, parse: ParseResult, execs: Exec[]): RoutineVerdict {
	const v = reservedVerdict(call, ctx, { tolerateUnread: true });
	if (v.refusal) return { ask: `row 6 still refuses it with unknown words tolerated (${v.refusal.reason.split(". ")[0]})` };
	const keyword = parse.compounds.find((k) => !own(READ_ONLY_KEYWORDS, k));
	if (keyword !== undefined) return { ask: `\`${keyword}\` (a compound command other than a group or a for loop)` };
	for (const c of parse.commands) {
		const bad = c.redirects.find((r) => !redirectAllowed(r));
		if (bad) return { ask: `a redirect \`${bad.fd ?? ""}${bad.op} ${bad.target?.text ?? ""}\` (only /dev/null and fd duplicates)` };
	}
	const readers = new Set<string>();
	const heads: string[] = [];
	for (const e of execs) {
		const why = allowListed(e);
		if (why) return { ask: why };
		const name = e.argv[0]!.text;
		if (name !== "for" && name !== "gh" && name !== "git") readers.add(name);
		heads.push(name);
	}
	const network = heads.includes("gh");
	if (network) {
		if (heads.includes("git")) return { ask: "git in a call that runs gh (a network call starts no git: run `git …` first and spell its output literally)" };
		const stderr = ghStderrHidden(cmd, parse);
		if (stderr) return { ask: stderr };
	}
	return { rule: "read-only", detail: `read-only: ${[...new Set(heads)].join(", ")}`, network, readers: [...readers].sort() };
}

/**
 * Why one expanded command is not on the read-only allow-list (D2a (ii), (iii)), or null: its redirects
 * go to /dev/null or duplicate an fd, its name is literal with no wrapper and no command-local
 * assignment, and its name and arguments match one table entry (a `for` header, a plain reader, a
 * git read form, a gh read).
 */
export function allowListed(e: Exec): string | null {
	const bad = e.redirects.find((r) => !redirectAllowed(r));
	if (bad) return `a redirect \`${bad.fd ?? ""}${bad.op} ${bad.target?.text ?? ""}\` (only /dev/null and fd duplicates)`;
	const head = e.argv[0]!;
	if (head.opaque || head.glob || head.expanded || head.text.includes("/")) return `the command name \`${head.text}\` is not literal text`;
	if (e.mods.wrappers.length > 0) return `\`${head.text}\` run through \`${e.mods.wrappers[0]}\``;
	if (e.mods.assigns.length > 0) return `\`${head.text}\` with a command-local assignment`;
	const name = head.text;
	const args = e.argv.slice(1);
	if (name === "for") return forHeader(args);
	if (name === "gh") return ghRead(args);
	if (name === "git") return gitRead(e);
	const reader = own(READERS, name);
	return reader ? reader(args) : `\`${name}\` is not a read-only command the classifier knows`;
}

/** A redirect a read-only call may hold: a heredoc or here-string, an fd duplicate or close, or any redirect of /dev/null. */
function redirectAllowed(r: Redirect): boolean {
	if (r.op === "<<" || r.op === "<<-" || r.op === "<<<") return true;
	const t = r.target;
	if (!t || t.opaque || t.glob) return false;
	if ((r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(t.text)) return true;
	return t.text === "/dev/null";
}

/**
 * Why gh's stderr may not reach the tool result (D2a (v)), or null. Read over the whole call, at
 * every depth, since a redirect on any enclosing node reaches gh: a redirect of fd 2 (`2>`, `2>&N`,
 * `&>`, `>&file`), `|&`, or a process substitution.
 */
function ghStderrHidden(cmd: string, parse: ParseResult): string | null {
	for (const c of parse.commands) {
		for (const r of c.redirects) {
			const both = r.op === "&>" || r.op === "&>>" || (r.op === ">&" && r.fd === undefined && !/^(\d+|-)$/.test(r.target?.text ?? ""));
			if (r.fd === "2" || both) return `a redirect of stderr (\`${r.fd ?? ""}${r.op}\`) in a call that runs gh`;
		}
	}
	if (cmd.includes("|&")) return "`|&` in a call that runs gh";
	if (/[<>]\(/.test(cmd)) return "a process substitution in a call that runs gh";
	return null;
}

/** `for NAME in WORD…`: the loop header the expander records as a command. */
function forHeader(args: Word[]): string | null {
	const name = args[0];
	if (!name || name.opaque || name.expanded || !/^[A-Za-z_]\w*$/.test(name.text) || args[1]?.text !== "in" || args[1].opaque) {
		return "a `for` loop other than `for NAME in WORD…`";
	}
	return null;
}

// Words. A known word is read as it is. A word with an unknown part (Word.opaque) passes only when the
// shell cannot split it (Word.splits false) and, where it could be an option, when its known head is
// literal text that does not start with `-`. A glob passes only when its first character is a literal
// that is not `-`, so nothing it expands to is an option.

/** Whether a word in an operand position cannot be an option. */
function operandOk(w: Word): boolean {
	if (w.opaque) {
		const f = w.fragments;
		if (w.splits !== false || w.candidates || !f || f.length !== 1) return false;
		const head = f[0]!.head;
		return head !== "" && !head.startsWith("-") && w.text.startsWith(head);
	}
	if (w.glob) return /^[^-*?[\\{]/.test(w.text);
	return true;
}

/** Whether a word in an option's value position stays that one value. */
function valueOk(w: Word): boolean {
	if (w.opaque) return w.splits === false;
	return !w.glob;
}

/**
 * One reader's options (D2a (iii)): short flags without a value (bundled as `-la`), short options
 * with a value (`-n5` or `-n 5`), long options with the number of value words each takes
 * (`--name=value` gives the first), `-NUM` (head, tail), and the most operands.
 */
interface ReaderSpec {
	flags?: string;
	valued?: string;
	long?: Record<string, number>;
	numeric?: boolean;
	maxOperands?: number;
}

/** The words after the options (and after `--`), or why the arguments ask. */
function readArgs(name: string, spec: ReaderSpec, args: Word[]): Word[] | string {
	const operands: Word[] = [];
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		const t = w.text;
		if (dashdash || w.opaque || w.glob || t === "-" || !t.startsWith("-")) {
			if (!operandOk(w)) return `\`${name}\` with a word not known until it runs that could be an option`;
			operands.push(w);
			continue;
		}
		if (t === "--") {
			dashdash = true;
			continue;
		}
		const take = (n: number, what: string): string | null => {
			for (let k = 0; k < n; k++) {
				const v = args[++i];
				if (!v || !valueOk(v)) return `\`${name} ${what}\` without a value the gate can read`;
			}
			return null;
		};
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const opt = eq < 0 ? t.slice(2) : t.slice(2, eq);
			const n = spec.long ? own(spec.long, opt) : undefined;
			if (n === undefined) return `\`${name} --${opt}\`, an option outside the read-only set`;
			const why = take(eq < 0 ? n : Math.max(0, n - 1), `--${opt}`);
			if (why) return why;
			continue;
		}
		if (spec.numeric && /^-\d+$/.test(t)) continue;
		for (let j = 1; j < t.length; j++) {
			const c = t[j]!;
			if (spec.flags?.includes(c)) continue;
			if (!spec.valued?.includes(c)) return `\`${name} -${c}\`, an option outside the read-only set`;
			if (j === t.length - 1) {
				const why = take(1, `-${c}`);
				if (why) return why;
			}
			break;
		}
	}
	if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) return `\`${name}\` with more than ${spec.maxOperands} operand${spec.maxOperands === 1 ? "" : "s"}`;
	return operands;
}

const spec = (name: string, s: ReaderSpec) => (args: Word[]): string | null => {
	const r = readArgs(name, s, args);
	return typeof r === "string" ? r : null;
};

/** Every word passes: test expressions and printed text, which run nothing. */
const anyWords = (): string | null => null;

const GREP_LONG: Record<string, number> = {
	"extended-regexp": 0, "fixed-strings": 0, "basic-regexp": 0, "perl-regexp": 0, regexp: 1, file: 1, "ignore-case": 0, "no-ignore-case": 0, "word-regexp": 0, "line-regexp": 0,
	"invert-match": 0, count: 0, color: 0, colour: 0, "files-without-match": 0, "files-with-matches": 0, "max-count": 1, "only-matching": 0, quiet: 0, silent: 0, "no-messages": 0,
	"byte-offset": 0, "with-filename": 0, "no-filename": 0, label: 1, "line-number": 0, "initial-tab": 0, null: 0, "null-data": 0, "after-context": 1, "before-context": 1, context: 1,
	text: 0, binary: 0, recursive: 0, "dereference-recursive": 0, include: 1, exclude: 1, "exclude-dir": 1, "exclude-from": 1, directories: 1, devices: 1,
};

const RG_LONG: Record<string, number> = {
	regexp: 1, file: 1, "after-context": 1, "before-context": 1, context: 1, "case-sensitive": 0, "ignore-case": 0, "smart-case": 0, count: 0, "count-matches": 0, color: 1, colors: 1,
	column: 0, "no-column": 0, "fixed-strings": 0, follow: 0, glob: 1, iglob: 1, heading: 0, "no-heading": 0, hidden: 0, "no-ignore": 0, "no-ignore-vcs": 0, "no-ignore-dot": 0,
	"ignore-file": 1, "files-with-matches": 0, "files-without-match": 0, files: 0, "line-number": 0, "no-line-number": 0, "max-count": 1, "max-depth": 1, "max-columns": 1,
	multiline: 0, "multiline-dotall": 0, "only-matching": 0, "invert-match": 0, "word-regexp": 0, "line-regexp": 0, json: 0, vimgrep: 0, replace: 1, sort: 1, sortr: 1, stats: 0,
	text: 0, trim: 0, type: 1, "type-not": 1, "type-list": 0, unrestricted: 0, "with-filename": 0, "no-filename": 0, null: 0, "null-data": 0, quiet: 0, pcre2: 0, "auto-hybrid-regex": 0,
	encoding: 1, threads: 1, passthru: 0, "no-messages": 0, "byte-offset": 0, "max-filesize": 1, "one-file-system": 0, "no-config": 0, "crlf": 0, "line-buffered": 0, "block-buffered": 0,
};

const JQ_LONG: Record<string, number> = {
	"raw-output": 0, "raw-output0": 0, "join-output": 0, "compact-output": 0, "null-input": 0, slurp: 0, "ascii-output": 0, "sort-keys": 0, "exit-status": 0, "color-output": 0,
	"monochrome-output": 0, "raw-input": 0, tab: 0, indent: 1, arg: 2, argjson: 2, slurpfile: 2, rawfile: 2, args: 0, jsonargs: 0, "from-file": 1, seq: 0, stream: 0, "stream-errors": 0,
};

const SORT_LONG: Record<string, number> = {
	"ignore-leading-blanks": 0, "dictionary-order": 0, "ignore-case": 0, "general-numeric-sort": 0, "ignore-nonprinting": 0, "month-sort": 0, "human-numeric-sort": 0,
	"numeric-sort": 0, "random-sort": 0, reverse: 0, "version-sort": 0, check: 0, key: 1, merge: 0, stable: 0, "field-separator": 1, unique: 0, "zero-terminated": 0,
};

/**
 * The plain readers (D2a (iii)), each with its own option set; an option outside it asks. `sort` has no
 * `-o`, `-T` or `--compress-program`; `uniq` takes at most one operand; `rg` has no `--pre`,
 * `--pre-glob`, `-z` or `--hostname-bin`; `file` has no `-C`; `tail` does not follow.
 */
const READERS: Record<string, (args: Word[]) => string | null> = {
	ls: spec("ls", { flags: "1@AaBbCcdeFfGgHhiklLmnOoPpqRrSsTtUuvWwx" }),
	cat: spec("cat", { flags: "benstuvAET" }),
	head: spec("head", { flags: "qv", valued: "nc", numeric: true, long: { lines: 1, bytes: 1, quiet: 0, silent: 0, verbose: 0 } }),
	tail: spec("tail", { flags: "qr", valued: "nbc", numeric: true, long: { lines: 1, bytes: 1, quiet: 0, silent: 0, verbose: 0 } }),
	wc: spec("wc", { flags: "clmwL", long: { bytes: 0, chars: 0, lines: 0, words: 0, "max-line-length": 0 } }),
	stat: spec("stat", { flags: "FLlnqrsx", valued: "fct", long: { format: 1, printf: 1, dereference: 0, terse: 0, "file-system": 0 } }),
	file: spec("file", { flags: "bhiIkLNnz0", valued: "mfeF", long: { brief: 0, mime: 0, "mime-type": 0, "mime-encoding": 0, "no-dereference": 0, dereference: 0 } }),
	pwd: spec("pwd", { flags: "LP", maxOperands: 0 }),
	basename: spec("basename", { flags: "az", valued: "s", long: { multiple: 0, suffix: 1, zero: 0 } }),
	dirname: spec("dirname", { flags: "z", long: { zero: 0 } }),
	realpath: spec("realpath", { flags: "emqsLPz", long: { "canonicalize-existing": 0, "canonicalize-missing": 0, quiet: 0, "no-symlinks": 0, strip: 0, logical: 0, physical: 0, zero: 0 } }),
	readlink: spec("readlink", { flags: "fenqsvmz", long: { canonicalize: 0, "canonicalize-existing": 0, "canonicalize-missing": 0, "no-newline": 0, quiet: 0, silent: 0, verbose: 0, zero: 0 } }),
	test: anyWords,
	"[": anyWords,
	true: anyWords,
	false: anyWords,
	echo: anyWords,
	printf: (args) => {
		const first = args[0];
		if (!first) return null;
		if (first.text === "-v" || first.text.startsWith("-v")) return "`printf -v` (assigns a shell variable)";
		return first.opaque && !operandOk(first) ? "`printf` with a first word not known until it runs (it could be -v)" : null;
	},
	diff: spec("diff", {
		flags: "abBdEiNnpqrsStTuwy",
		valued: "CUxXIL",
		long: { brief: 0, recursive: 0, unified: 0, context: 0, "new-file": 0, "ignore-case": 0, "ignore-all-space": 0, "ignore-space-change": 0, "ignore-blank-lines": 0, "side-by-side": 0, color: 0, "report-identical-files": 0, exclude: 1, label: 1, "strip-trailing-cr": 0, text: 0, normal: 0, "suppress-common-lines": 0 },
	}),
	cmp: spec("cmp", { flags: "bhilsxz", valued: "n", long: { "print-bytes": 0, verbose: 0, quiet: 0, silent: 0, "ignore-initial": 1, bytes: 1 } }),
	cut: spec("cut", { flags: "nswz", valued: "bcdf", long: { bytes: 1, characters: 1, delimiter: 1, fields: 1, "only-delimited": 0, complement: 0, "output-delimiter": 1, "zero-terminated": 0 } }),
	tr: spec("tr", { flags: "cCdsu", maxOperands: 2 }),
	nl: spec("nl", { flags: "p", valued: "bdfhilnsvw" }),
	comm: spec("comm", { flags: "123iz", maxOperands: 2 }),
	grep: spec("grep", { flags: "abcEFGhHiIlLnoqrRsTuUvVwxyzZ", valued: "ABCefmdD", numeric: true, long: GREP_LONG }),
	rg: spec("rg", { flags: "acFhHiIlLnNopPqsSuUvwx0.", valued: "ABCefgmtTMjrE", long: RG_LONG }),
	jq: spec("jq", { flags: "rjcnsaSeCMRh", valued: "fL", long: JQ_LONG }),
	sort: spec("sort", { flags: "bdfgiMnRrsuVcCmhz", valued: "ktS", long: SORT_LONG }),
	uniq: spec("uniq", { flags: "cdDiuz", valued: "fs", long: { count: 0, repeated: 0, "all-repeated": 0, "ignore-case": 0, unique: 0, "skip-fields": 1, "skip-chars": 1, "zero-terminated": 0 }, maxOperands: 1 }),
	find: findArgs,
	sed: sedArgs,
	date: dateArgs,
	sleep: (args) => (args.length > 0 && args.every((w) => !w.opaque && !w.glob && /^\d+(\.\d+)?[smhd]?$/.test(w.text)) ? null : "`sleep` with an operand other than a literal duration"),
};

/** BSD find options before the paths. */
const FIND_OPTIONS: Record<string, true> = { "-H": true, "-L": true, "-P": true, "-E": true, "-X": true, "-d": true, "-s": true, "-x": true };
/** find's listing primaries (D2a (iii)), with the number of value words each takes. No -exec, -execdir, -ok, -delete or -fprint family. */
const FIND_PRIMARIES: Record<string, number> = {
	"-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-wholename": 1, "-iwholename": 1, "-regex": 1, "-iregex": 1, "-lname": 1, "-ilname": 1, "-type": 1, "-xtype": 1,
	"-maxdepth": 1, "-mindepth": 1, "-mtime": 1, "-mmin": 1, "-atime": 1, "-amin": 1, "-ctime": 1, "-cmin": 1, "-newer": 1, "-size": 1, "-perm": 1, "-user": 1, "-group": 1,
	"-uid": 1, "-gid": 1, "-links": 1, "-inum": 1, "-samefile": 1, "-printf": 1, "-empty": 0, "-print": 0, "-print0": 0, "-ls": 0, "-prune": 0, "-depth": 0, "-follow": 0,
	"-xdev": 0, "-mount": 0, "-true": 0, "-false": 0, "-not": 0, "-and": 0, "-a": 0, "-or": 0, "-o": 0, "-nouser": 0, "-nogroup": 0, "-readable": 0, "-writable": 0,
	"-executable": 0, "!": 0, "(": 0, ")": 0,
};

function findArgs(args: Word[]): string | null {
	let i = 0;
	while (i < args.length && !args[i]!.opaque && own(FIND_OPTIONS, args[i]!.text)) i++;
	// Paths, up to the first expression word.
	while (i < args.length) {
		const w = args[i]!;
		if (!w.opaque && (w.text.startsWith("-") || w.text === "!" || w.text === "(")) break;
		if (!operandOk(w)) return "`find` with a path not known until it runs that could be a primary";
		i++;
	}
	for (; i < args.length; i++) {
		const w = args[i]!;
		const n = w.opaque || w.glob ? undefined : own(FIND_PRIMARIES, w.text);
		if (n === undefined) return `\`find ${w.text || "…"}\`, a primary outside the listing set (no -exec, -delete or -fprint)`;
		for (let k = 0; k < n; k++) {
			const v = args[++i];
			if (!v || !valueOk(v)) return `\`find ${w.text}\` without a value the gate can read`;
		}
	}
	return null;
}

/** sed: `-n`, `-E`, `-e <script>`, a literal script of addresses and `s///[gip0-9]`, `p`, `d`, `q` (no `w`, `e`, `r`, no `-i`), then file operands. */
function sedArgs(args: Word[]): string | null {
	const scripts: Word[] = [];
	const operands: Word[] = [];
	let dashdash = false;
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		const t = w.text;
		if (dashdash || w.opaque || w.glob || t === "-" || !t.startsWith("-")) {
			operands.push(w);
			continue;
		}
		if (t === "--") {
			dashdash = true;
			continue;
		}
		for (let j = 1; j < t.length; j++) {
			const c = t[j]!;
			if (c === "n" || c === "E") continue;
			if (c !== "e") return `\`sed -${c}\`, an option outside -n, -E and -e`;
			const rest = t.slice(j + 1);
			const v = rest === "" ? args[++i] : { text: rest, opaque: false };
			if (!v) return "`sed -e` without a script";
			scripts.push(v);
			break;
		}
	}
	if (scripts.length === 0) {
		const s = operands.shift();
		if (!s) return "`sed` without a script";
		scripts.push(s);
	}
	for (const s of scripts) {
		if (s.opaque || s.glob || !sedScriptOk(s.text)) return `\`sed\` with a script other than addresses and s///, p, d, q (${JSON.stringify(s.text.slice(0, 60))})`;
	}
	const bad = operands.find((w) => !operandOk(w));
	return bad ? "`sed` with a file word not known until it runs that could be an option" : null;
}

/** The index just past the `delim` that closes the sed regex or replacement starting at `i`, or -1. */
function sedDelimited(s: string, i: number, delim: string): number {
	for (let k = i; k < s.length; k++) {
		if (s[k] === "\\") {
			k++;
			continue;
		}
		if (s[k] === "\n") return -1;
		if (s[k] === delim) return k + 1;
	}
	return -1;
}

/** A sed script of commands `[addr[,addr]][!]` then `p`, `d`, `q[N]` or `s/re/rep/[gip0-9]*`, separated by `;` or newlines. */
function sedScriptOk(s: string): boolean {
	let i = 0;
	const blanks = (): void => {
		while (s[i] === " " || s[i] === "\t") i++;
	};
	const address = (): boolean => {
		if (/\d/.test(s[i] ?? "")) {
			while (/\d/.test(s[i] ?? "")) i++;
			return true;
		}
		if (s[i] === "$") {
			i++;
			return true;
		}
		if (s[i] === "/") {
			i = sedDelimited(s, i + 1, "/");
			return i > 0;
		}
		return false;
	};
	for (;;) {
		while (i < s.length && " \t\n;".includes(s[i]!)) i++;
		if (i >= s.length) return true;
		if (address() && s[i] === ",") {
			i++;
			if (!address()) return false;
		}
		if (i < 0) return false;
		blanks();
		if (s[i] === "!") i++;
		blanks();
		const c = s[i++];
		if (c === "q") {
			while (/\d/.test(s[i] ?? "")) i++;
		} else if (c === "s") {
			const d = s[i++];
			if (d === undefined || d === "\\" || d === "\n" || d === " ") return false;
			i = sedDelimited(s, i, d);
			if (i < 0) return false;
			i = sedDelimited(s, i, d);
			if (i < 0) return false;
			while (i < s.length && /[gip0-9]/.test(s[i]!)) i++;
		} else if (c !== "p" && c !== "d") return false;
		blanks();
		if (i < s.length && s[i] !== ";" && s[i] !== "\n") return false;
	}
}

/** date: `+FORMAT`, `-u` and `-r <seconds or file>` only; an operand that sets the clock asks. */
function dateArgs(args: Word[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		if (w.opaque || w.glob) return "`date` with a word not known until it runs";
		if (w.text === "-u" || w.text.startsWith("+")) continue;
		if (w.text === "-r") {
			const v = args[++i];
			if (!v || !valueOk(v)) return "`date -r` without a value the gate can read";
			continue;
		}
		return `\`date ${w.text}\`, outside +FORMAT, -u and -r`;
	}
	return null;
}

/** git subcommands that only read, with any of their options but `--output` (and `git grep -O`); gitModel has judged them under (i). */
const GIT_OPEN_READS: Record<string, true> = {
	log: true, show: true, diff: true, "rev-parse": true, "rev-list": true, "ls-files": true, "ls-tree": true, "cat-file": true, "merge-base": true, describe: true, blame: true,
	shortlog: true, grep: true, "name-rev": true, "for-each-ref": true,
};
/** `git branch` and `git tag` list-mode options; value words per option. */
const GIT_LIST_OPTS: Record<string, Record<string, number>> = {
	branch: { "-a": 0, "--all": 0, "-r": 0, "--remotes": 0, "-v": 0, "-vv": 0, "--verbose": 0, "-l": 0, "--list": 0, "--contains": 1, "--no-contains": 1, "--merged": 1, "--no-merged": 1, "--points-at": 1, "--sort": 1, "--format": 1, "--show-current": 0, "--color": 0, "--no-color": 0, "-i": 0, "--ignore-case": 0, "--omit-empty": 0 },
	tag: { "-l": 0, "--list": 0, "-n": 0, "--contains": 1, "--no-contains": 1, "--merged": 1, "--no-merged": 1, "--points-at": 1, "--sort": 1, "--format": 1, "-i": 0, "--ignore-case": 0, "--color": 0, "--omit-empty": 0 },
};

/**
 * A git read form (D2a (iii)), or why it asks: a literal subcommand, globals only `-C <literal>` and
 * `--no-pager`, every argument known, and one of the read forms. fetch, pull, push, gc, config writes
 * and every other form ask.
 */
function gitRead(e: Exec): string | null {
	const g = gitCall(e);
	if (!g || g.sub === null || g.sub === "") return "git without a literal subcommand";
	for (let i = 0; i < g.globals.length; i++) {
		const w = g.globals[i]!;
		if (w.text === "--no-pager") continue;
		if (w.text === "-C") {
			const p = g.globals[++i];
			if (!p || p.opaque || p.glob || p.expanded) return "git -C with a path that is not literal text";
			continue;
		}
		return `git ${w.text || "…"}, a global option outside -C and --no-pager`;
	}
	const sub = g.sub;
	const args = g.args;
	if (args.some((w) => w.opaque || (w.glob && !operandOk(w)))) return `git ${sub} with a word not known until it runs`;
	const t = args.map((w) => w.text);
	if (own(GIT_OPEN_READS, sub)) {
		if (t.some((a) => a === "--output" || a.startsWith("--output="))) return `git ${sub} --output (writes a file)`;
		if (sub === "grep" && t.some((a) => a === "--open-files-in-pager" || a.startsWith("--open-files-in-pager=") || /^-O/.test(a))) return "git grep -O (runs a pager program)";
		return null;
	}
	switch (sub) {
		case "status":
			return t.every((a) => /^(--porcelain(=v[12])?|-s|-b|-sb|-bs)$/.test(a)) ? null : "git status with options other than --porcelain, -s and -b";
		case "symbolic-ref": {
			const ops = t.filter((a) => !/^(-q|--quiet|--short)$/.test(a));
			return ops.length === 1 && !ops[0]!.startsWith("-") ? null : "git symbolic-ref other than reading one name";
		}
		case "branch":
		case "tag": {
			const opts = GIT_LIST_OPTS[sub]!;
			let list = false;
			let operands = 0;
			for (let i = 0; i < t.length; i++) {
				const a = t[i]!;
				if (!a.startsWith("-")) {
					operands++;
					continue;
				}
				const eq = a.indexOf("=");
				const name = eq < 0 ? a : a.slice(0, eq);
				const n = sub === "tag" && /^-n\d*$/.test(a) ? 0 : own(opts, name);
				if (n === undefined) return `git ${sub} ${name}, an option outside list mode`;
				if (name === "-l" || name === "--list") list = true;
				if (eq < 0) i += n;
				if (i >= t.length) return `git ${sub} ${name} without a value`;
			}
			return operands === 0 || list ? null : `git ${sub} with a name (creates a ${sub})`;
		}
		case "remote":
			if (t.length === 1 && (t[0] === "-v" || t[0] === "--verbose")) return null;
			if (t[0] === "get-url") {
				const ops = t.slice(1).filter((a) => a !== "--push" && a !== "--all");
				return ops.length === 1 && !ops[0]!.startsWith("-") ? null : "git remote get-url other than one remote name";
			}
			return "git remote other than -v and get-url";
		case "config":
			if (t.length === 1 && (t[0] === "--list" || t[0] === "-l")) return null;
			if ((t[0] === "--get" || t[0] === "--get-all" || t[0] === "--get-regexp") && (t.length === 2 || t.length === 3) && t.slice(1).every((a) => !a.startsWith("-"))) return null;
			return "git config other than --get, --get-all, --get-regexp and --list";
		case "worktree":
			return t[0] === "list" && t.slice(1).every((a) => /^(--porcelain|-v|--verbose|-z)$/.test(a)) ? null : "git worktree other than list";
		case "stash":
		case "reflog":
			if (t[0] !== (sub === "stash" ? "list" : "show")) return `git ${sub} other than ${sub === "stash" ? "list" : "show"}`;
			return t.some((a) => a === "--output" || a.startsWith("--output=")) ? `git ${sub} --output (writes a file)` : null;
	}
	return `git ${sub}, not a git read form`;
}

/**
 * gh read subcommands and their flags that write nothing, pinned to `gh <cmd> --help` of gh 2.102.0
 * (2026-09-30), read 2026-10-27 for PLAN wl-mvqwn80onq9hq8 D2a; `--web` and its short form left out.
 * 1 marks a flag that takes a value.
 */
const GH_READS: Record<string, Record<string, number>> = {
	"issue list": { "--app": 1, "--assignee": 1, "-a": 1, "--author": 1, "-A": 1, "--jq": 1, "-q": 1, "--json": 1, "--label": 1, "-l": 1, "--limit": 1, "-L": 1, "--mention": 1, "--milestone": 1, "-m": 1, "--search": 1, "-S": 1, "--state": 1, "-s": 1, "--template": 1, "-t": 1, "--type": 1, "-R": 1, "--repo": 1 },
	"issue status": { "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"issue view": { "--comments": 0, "-c": 0, "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"pr checks": { "--fail-fast": 0, "--interval": 1, "-i": 1, "--jq": 1, "-q": 1, "--json": 1, "--required": 0, "--template": 1, "-t": 1, "--watch": 0, "-R": 1, "--repo": 1 },
	"pr diff": { "--allow-escape-sequences": 0, "--color": 1, "--exclude": 1, "-e": 1, "--name-only": 0, "--patch": 0, "-R": 1, "--repo": 1 },
	"pr list": { "--app": 1, "--assignee": 1, "-a": 1, "--author": 1, "-A": 1, "--base": 1, "-B": 1, "--draft": 0, "-d": 0, "--head": 1, "-H": 1, "--jq": 1, "-q": 1, "--json": 1, "--label": 1, "-l": 1, "--limit": 1, "-L": 1, "--search": 1, "-S": 1, "--state": 1, "-s": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"pr status": { "--conflict-status": 0, "-c": 0, "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"pr view": { "--comments": 0, "-c": 0, "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"release list": { "--exclude-drafts": 0, "--exclude-pre-releases": 0, "--jq": 1, "-q": 1, "--json": 1, "--limit": 1, "-L": 1, "--order": 1, "-O": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"release view": { "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"repo view": { "--branch": 1, "-b": 1, "--jq": 1, "-q": 1, "--json": 1, "--template": 1, "-t": 1 },
	"run list": { "--all": 0, "-a": 0, "--branch": 1, "-b": 1, "--commit": 1, "-c": 1, "--created": 1, "--event": 1, "-e": 1, "--jq": 1, "-q": 1, "--json": 1, "--limit": 1, "-L": 1, "--status": 1, "-s": 1, "--template": 1, "-t": 1, "--user": 1, "-u": 1, "--workflow": 1, "-w": 1, "-R": 1, "--repo": 1 },
	"run view": { "--attempt": 1, "-a": 1, "--exit-status": 0, "--job": 1, "-j": 1, "--jq": 1, "-q": 1, "--json": 1, "--log": 0, "--log-failed": 0, "--template": 1, "-t": 1, "--verbose": 0, "-v": 0, "-R": 1, "--repo": 1 },
	"search code": { "--extension": 1, "--filename": 1, "--jq": 1, "-q": 1, "--json": 1, "--language": 1, "--limit": 1, "-L": 1, "--match": 1, "--owner": 1, "--repo": 1, "-R": 1, "--size": 1, "--template": 1, "-t": 1 },
	"search commits": { "--author": 1, "--author-date": 1, "--author-email": 1, "--author-name": 1, "--committer": 1, "--committer-date": 1, "--committer-email": 1, "--committer-name": 1, "--hash": 1, "--jq": 1, "-q": 1, "--json": 1, "--limit": 1, "-L": 1, "--merge": 0, "--order": 1, "--owner": 1, "--parent": 1, "--repo": 1, "-R": 1, "--sort": 1, "--template": 1, "-t": 1, "--tree": 1, "--visibility": 1 },
	"search issues": { "--app": 1, "--archived": 0, "--assignee": 1, "--author": 1, "--closed": 1, "--commenter": 1, "--comments": 1, "--created": 1, "--include-prs": 0, "--interactions": 1, "--involves": 1, "--jq": 1, "-q": 1, "--json": 1, "--label": 1, "--language": 1, "--limit": 1, "-L": 1, "--locked": 0, "--match": 1, "--mentions": 1, "--milestone": 1, "--no-assignee": 0, "--no-label": 0, "--no-milestone": 0, "--no-project": 0, "--order": 1, "--owner": 1, "--project": 1, "--reactions": 1, "--repo": 1, "-R": 1, "--search-type": 1, "--sort": 1, "--state": 1, "--team-mentions": 1, "--template": 1, "-t": 1, "--updated": 1, "--visibility": 1 },
	"search prs": { "--app": 1, "--archived": 0, "--assignee": 1, "--author": 1, "--base": 1, "-B": 1, "--checks": 1, "--closed": 1, "--commenter": 1, "--comments": 1, "--created": 1, "--draft": 0, "--head": 1, "-H": 1, "--interactions": 1, "--involves": 1, "--jq": 1, "-q": 1, "--json": 1, "--label": 1, "--language": 1, "--limit": 1, "-L": 1, "--locked": 0, "--match": 1, "--mentions": 1, "--merged": 0, "--merged-at": 1, "--milestone": 1, "--no-assignee": 0, "--no-label": 0, "--no-milestone": 0, "--no-project": 0, "--order": 1, "--owner": 1, "--project": 1, "--reactions": 1, "--repo": 1, "-R": 1, "--review": 1, "--review-requested": 1, "--reviewed-by": 1, "--sort": 1, "--state": 1, "--team-mentions": 1, "--template": 1, "-t": 1, "--updated": 1, "--visibility": 1 },
	"search repos": { "--archived": 0, "--created": 1, "--followers": 1, "--forks": 1, "--good-first-issues": 1, "--help-wanted-issues": 1, "--include-forks": 1, "--jq": 1, "-q": 1, "--json": 1, "--language": 1, "--license": 1, "--limit": 1, "-L": 1, "--match": 1, "--number-topics": 1, "--order": 1, "--owner": 1, "--size": 1, "--sort": 1, "--stars": 1, "--template": 1, "-t": 1, "--topic": 1, "--updated": 1, "--visibility": 1 },
	"workflow list": { "--all": 0, "-a": 0, "--jq": 1, "-q": 1, "--json": 1, "--limit": 1, "-L": 1, "--template": 1, "-t": 1, "-R": 1, "--repo": 1 },
	"workflow view": { "--ref": 1, "-r": 1, "--yaml": 0, "-y": 0, "-R": 1, "--repo": 1 },
};

/** `gh api` options a GET read may carry (D2a (iii)), besides `-X GET` / `--method GET`; 1 marks a value. */
const GH_API_OPTS: Record<string, number> = { "--jq": 1, "-q": 1, "--paginate": 0, "--slurp": 0, "-i": 0, "--include": 0, "--silent": 0, "-t": 1, "--template": 1 };
/** The REST roots a `gh api` endpoint may start with: prefixes, and the two that are whole names. */
const GH_API_ROOTS = ["repos/", "/repos/", "orgs/", "users/", "search/"];
const GH_API_NAMES = ["user", "rate_limit"];

/** Whether a literal endpoint text starts with a REST root (never `graphql`) and holds no `..` segment. */
function restEndpoint(text: string): boolean {
	if (text.split(/[/?]/).includes("..")) return false;
	return GH_API_ROOTS.some((r) => text.startsWith(r)) || GH_API_NAMES.some((n) => text === n || text.startsWith(`${n}/`) || text.startsWith(`${n}?`));
}

/** A gh read (D2a (iii)): a read subcommand with its documented non-writing flags, or a GET-only `gh api`. */
function ghRead(args: Word[]): string | null {
	const [group, sub] = args;
	if (!group || group.opaque || group.glob || !sub || sub.opaque || sub.glob) {
		if (group && !group.opaque && group.text === "api") return ghApi(args.slice(1));
		return "gh without a literal subcommand";
	}
	if (group.text === "api") return ghApi(args.slice(1));
	const table = own(GH_READS, `${group.text} ${sub.text}`);
	if (!table) return `gh ${group.text} ${sub.text}, not a gh read subcommand`;
	const rest = args.slice(2);
	for (let i = 0; i < rest.length; i++) {
		const w = rest[i]!;
		// An unknown word may stand anywhere after the literal subcommand (D2a (iii)).
		if (w.opaque) continue;
		const t = w.text;
		if (t === "--") break;
		if (!t.startsWith("-") || t === "-") continue;
		const eq = t.indexOf("=");
		const name = eq < 0 ? t : t.slice(0, eq);
		const n = own(table, name);
		if (n === undefined) return `gh ${group.text} ${sub.text} ${name}, a flag outside the read set`;
		if (eq < 0 && n === 1) {
			if (++i >= rest.length) return `gh ${group.text} ${sub.text} ${name} without a value`;
		}
	}
	return null;
}

/**
 * `gh api` as a GET read (D2a (iii)): no method but GET, no field or input, options within
 * GH_API_OPTS, and exactly one endpoint word that starts with a literal REST root. An endpoint with an
 * unknown part must not be field-split (Word.splits false) and its one known head must start with a
 * root, so it can never be `graphql` (for which gh would send POST).
 */
function ghApi(args: Word[]): string | null {
	const endpoints: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const w = args[i]!;
		const t = w.text;
		if (w.opaque || w.glob || !t.startsWith("-")) {
			endpoints.push(w);
			continue;
		}
		const eq = t.indexOf("=");
		const name = eq < 0 ? t : t.slice(0, eq);
		if (name === "-X" || name === "--method" || /^-X./.test(t)) {
			const value = eq >= 0 ? t.slice(eq + 1) : t.startsWith("-X") && t.length > 2 ? t.slice(2) : args[++i]?.opaque ? null : args[i]?.text;
			if (value?.toUpperCase() !== "GET") return "gh api with a method other than GET";
			continue;
		}
		const n = own(GH_API_OPTS, name);
		if (n === undefined) return `gh api ${name}, an option outside ${Object.keys(GH_API_OPTS).join(" ")} (no field, input or header)`;
		if (eq < 0 && n === 1) {
			const v = args[++i];
			if (!v || !valueOk(v)) return `gh api ${name} without a value the gate can read`;
		}
	}
	if (endpoints.length !== 1) return `gh api with ${endpoints.length} endpoint words (exactly one)`;
	const e = endpoints[0]!;
	if (e.glob) return "gh api with an endpoint that is a glob";
	if (!e.opaque) return restEndpoint(e.text) ? null : `gh api ${e.text}, an endpoint outside the REST roots ${[...GH_API_ROOTS, ...GH_API_NAMES].join(" ")}`;
	if (e.splits !== false) return "gh api with an endpoint the shell may split (an unquoted substitution or variable)";
	const f = e.fragments;
	if (e.candidates || !f || f.length !== 1 || !e.text.startsWith(f[0]!.head)) return "gh api with an endpoint whose known start the gate cannot read";
	const { head, tail } = f[0]!;
	if (!restEndpoint(head) || head.split(/[/?]/).includes("..") || tail.split(/[/?]/).includes("..")) return `gh api with an endpoint starting \`${head}\`, outside the REST roots`;
	return null;
}

// ---------------------------------------------------------------------------------------------
// Case 2: confined to the own scratch root or the own worktree (D2b)

function caseConfined(call: ToolCall, ctx: RoutineContext, scratchRoot: string, execs: Exec[]): RoutineVerdict {
	const v = reservedVerdict(call, ctx, { scratchRelative: true, ...(ctx.worktreeRoot ? { worktreeRoot: ctx.worktreeRoot } : {}) });
	if (v.refusal) return { ask: `row 6 still refuses it with targets confined (${v.refusal.reason.split(". ")[0]})` };
	if (v.scratch.length > 0 && v.worktree.length > 0) {
		return { ask: `the call mixes roots: scratch (${v.scratch.join(", ")}) and worktree (${v.worktree.join(", ")})` };
	}
	if (v.scratch.length > 0) return { rule: "scratch", detail: `scratch: ${v.scratch.join(", ")}`, network: false, root: scratchRoot };
	if (v.worktree.length === 0) return { ask: "row 6 lets the call through with no scratch or worktree rule (nothing to confine)" };
	const resets = v.worktree.filter((w) => /^git: git reset --(merge|keep)\b/.test(w));
	if (resets.length > 0) {
		const why = resetOnOwnBranch(ctx, execs);
		if (why) return { ask: why };
	}
	return { rule: "worktree", detail: `worktree: ${v.worktree.join(", ")}`, network: false, root: ctx.worktreeRoot! };
}

/**
 * `git reset --merge|--keep` lifts in the own worktree only on its own attached branch `wl/<workload>`,
 * and only in a call that switches or checks out nothing (D2b, the worktree fence: the profile then
 * allows that one branch ref).
 */
function resetOnOwnBranch(ctx: RoutineContext, execs: Exec[]): string | null {
	const id = ctx.env[WORKLOAD_ENV];
	const own = id ? `wl/${id}` : null;
	const branch = currentBranch(ctx.worktreeRoot!);
	if (own === null || branch !== own) return `git reset --merge/--keep in the worktree on ${branch ? `branch ${branch}` : "a detached HEAD"}, not the workload's own ${own ?? "branch"}`;
	for (const e of execs) {
		const g = basename(e.argv[0]!.text) === "git" ? gitCall(e) : null;
		if (g && (g.sub === "switch" || g.sub === "checkout")) return `git ${g.sub} in a call that resets the worktree's branch`;
	}
	return null;
}
