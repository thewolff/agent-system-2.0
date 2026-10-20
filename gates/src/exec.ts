// What a shell command string runs, as the tool-call rows (6, 8, 10) judge it: every simple command
// with wrappers stripped (`env`, `sudo`, `command`, `nohup`, `time`, `timeout`, …, and `env -S`'s
// split string) and every command reached through another — `sh -c`, `eval`, a heredoc or
// herestring fed to a shell, `echo … | sh` and `printf … | sh` (the producer's output computed the
// way printf formats it), `xargs`, `find -exec`,
// a script run by path or `source` (not under a shell's `-n`, which only checks syntax), `$(…)`. Inline interpreter code (`bun -e`, `python -c`,
// `perl -ne`, a heredoc or pipe into an interpreter, …) is returned as code for the eval checks.
// git aliases are not expanded: `-c alias.*` and a subcommand that is not git's own are refused as
// unmodeled by gitUnmodeled (M4 fix round 4, B1), so nothing here looks one up.
// What the gate cannot see (a shell reading a pipe from an unknown producer, `sh -c "$X"`, a command
// name that is a glob, a script the same command writes first, a parse failure) is returned as
// `blind`, and the rows fail closed on it (astra review B1, B2; round 2 R2-B1, R2-B2).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { BUN_SHELL_TAG, type CodeFacts, codeFacts, SCRIPT_SPAWN_API, SPAWN_API } from "./eval-code";
import { insideDotGit } from "./git-model";
import { dropLead, type ParseOptions, parseShell, type Redirect, type SimpleCommand, type VarValue, type Word } from "./shell-parse";

export interface Exec {
	/** argv after wrappers, quote removal and expansion. `argv[0]` is the command. */
	argv: Word[];
	redirects: Redirect[];
	dir: string;
	dirKnown: boolean;
	/** The simple command this came from (for pipes). */
	source: SimpleCommand;
	/** What `unwrap` stripped: command-local `NAME=value` words (and `env`'s), and each wrapper with its flags. */
	mods: Mods;
}

/** What wraps a command: its command-local assignments and wrapper commands (`env -u X`, `sudo -u u`, `command -v`). */
export interface Mods {
	assigns: Word[];
	wrappers: string[];
}

export const noMods = (): Mods => ({ assigns: [], wrappers: [] });

/** Language families of inline interpreter code. */
export type CodeFamily = "js" | "python" | "perl" | "ruby" | "php" | "osascript";

export interface InlineCode {
	/** The interpreter (`bun`, `node`, `python3`, `perl`, …). */
	lang: string;
	family: CodeFamily;
	text: string;
	dir: string;
}

export interface Expansion {
	commands: Exec[];
	code: InlineCode[];
	/** Reasons some of what runs is invisible to the gate. Non-empty = fail closed. */
	blind: string[];
	/**
	 * Every variable the command string assigns anywhere (a prefix `NAME=v cmd`, a bare `NAME=v;`,
	 * `export`/`declare`/`local`/`readonly`/`typeset`, `env NAME=v`, `env -u NAME`), by name, with
	 * every occurrence in order. An exported one reaches every later command's environment, so git
	 * overrides are judged on the whole string (M4 fix round 3, R3-B1); an earlier one keeps its effect
	 * on the commands it reached when a later one reassigns the name, so each occurrence is judged
	 * (M4 fix round 8, astra-8 B1: `NODE_REDIRECT_WARNINGS=<ledger> node …; NODE_REDIRECT_WARNINGS=x node …`).
	 */
	assigned: Map<string, Word[]>;
}

export const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, ksh: true, dash: true, ash: true, fish: true };
/**
 * Wrappers that run their arguments as a command: how many leading operands they take after their
 * flags, and which of their flags take a separate value word. `env -S` is handled on its own: its
 * value is a command line env splits and runs (astra review round 2, R2-B1).
 */
const WRAPPERS: Record<string, { operands: number; valueFlags: RegExp }> = {
	command: { operands: 0, valueFlags: /^$/ },
	builtin: { operands: 0, valueFlags: /^$/ },
	exec: { operands: 0, valueFlags: /^-a$/ },
	nohup: { operands: 0, valueFlags: /^$/ },
	time: { operands: 0, valueFlags: /^-[fo]$/ },
	nice: { operands: 0, valueFlags: /^(-n|--adjustment)$/ },
	sudo: { operands: 0, valueFlags: /^(-[ugpCDhrtTUR]|--(user|group|prompt|close-from|chdir|host|role|type|command-timeout|other-user|chroot))$/ },
	doas: { operands: 0, valueFlags: /^-[uC]$/ },
	env: { operands: 0, valueFlags: /^(-[uCP]|--(unset|chdir))$/ },
	stdbuf: { operands: 0, valueFlags: /^-[ioe]$/ },
	caffeinate: { operands: 0, valueFlags: /^-[tw]$/ },
	timeout: { operands: 1, valueFlags: /^(-[sk]|--(signal|kill-after))$/ },
	ionice: { operands: 0, valueFlags: /^-[cnp]$/ },
	chronic: { operands: 0, valueFlags: /^$/ },
	// `sandbox-exec [-f file | -n name | -p profile] [-D key=value]… command [args]` (sandbox-exec(1)):
	// a Seatbelt wrapper, followed like the rest so a quote-split head (`sand''box-exec`) is seen as
	// one and the command under it is judged (item 65 review B1). Row 6 refuses the wrapped form by
	// name, since the fence adds sandbox-exec itself.
	"sandbox-exec": { operands: 0, valueFlags: /^-[fnpD]$/ },
};

/** The code family an interpreter name runs, or null (`python3.12` → python, `nodejs` → js). */
export function interpreterFamily(name: string): CodeFamily | null {
	if (/^(node|nodejs|bun|deno)$/.test(name)) return "js";
	if (/^(python|pypy)[\d.]*$/.test(name)) return "python";
	if (/^perl[\d.]*$/.test(name)) return "perl";
	if (/^j?ruby[\d.]*$/.test(name)) return "ruby";
	if (/^php[\d.]*$/.test(name)) return "php";
	if (name === "osascript") return "osascript";
	return null;
}

/** Output-only commands: their arguments are text, never run, unless a consumer runs their output. */
export const OUTPUT_ONLY: Record<string, true> = { echo: true, printf: true };

/** Directories whose programs are the system's own: `/usr/bin/git` is `git` (astra review round 2 false positive). */
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;

/**
 * git's own commands: an alias of the same name is ignored by git ("aliases that hide existing Git
 * commands are ignored", git-config(1) `alias.*`), so a subcommand in this set runs what it says. Any
 * other subcommand may be a configured alias or a `git-*` program on PATH, which the gate does not
 * read, so gitUnmodeled refuses it (M4 fix round 4, B1).
 * Source: `git --list-cmds=main` on git 2.50.1 (Apple Git-155), 170 names, plus `citool`, `gui` and
 * `instaweb`, which git ships but this install lacks (they need Tcl/Tk or a web server). Refresh: run
 * `git --list-cmds=main | sort` on the git a profile pins and replace the list; keep names git has
 * dropped, since an older git may still run them.
 */
const GIT_BUILTINS = new Set(
	(
		"add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore " +
		"check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick citool clean clone column " +
		"commit commit-graph commit-tree config count-objects credential credential-cache credential-cache--daemon " +
		"credential-osxkeychain credential-store daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree " +
		"difftool difftool--helper fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref " +
		"for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc get-tar-commit-id grep gui gui--askpass hash-object " +
		"help hook http-backend http-fetch http-push imap-send index-pack init init-db instaweb interpret-trailers log ls-files " +
		"ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file " +
		"merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve merge-subtree merge-tree mergetool " +
		"mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id pickaxe prune " +
		"prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd " +
		"remote-ftp remote-ftps remote-http remote-https repack replace replay request-pull rerere reset restore rev-list " +
		"rev-parse revert rm send-email send-pack sh-i18n--envsubst shell shortlog show show-branch show-index show-ref " +
		"sparse-checkout stage stash status stripspace submodule submodule--helper subtree switch symbolic-ref tag unpack-file " +
		"unpack-objects update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var " +
		"verify-commit verify-pack verify-tag version web--browse whatchanged worktree write-tree"
	).split(" "),
);

/**
 * Shell option names (lowercase, underscores removed: zsh's spelling rules) that `-o`/`+o` may set
 * after `-n` without the gate dropping its read shortcut: none of them runs anything. Any other name
 * may be zsh's `exec` in some spelling, or an option the gate does not model, and drops it.
 */
const NOEXEC_NEUTRAL_OPTION = /^(?:xtrace|verbose|errexit|nounset|pipefail)$/;
/** Option words after `-n` that leave noexec as it is: `-`/`+` clusters of x, v, e, u (and `n`, `c` with `-`), `--norc`, `--noprofile`. */
const NOEXEC_NEUTRAL_WORD = /^(?:-[xveunc]+|\+[xveu]+|--norc|--noprofile)$/;

const MAX_DEPTH = 4;
const MAX_SCRIPT_BYTES = 256 * 1024;

const OPAQUE_HEAD: Word[] = [{ text: "", opaque: true }];

/**
 * Strip leading `NAME=value` assignments and wrapper commands (with their flags). `split` turns an
 * `env -S` string into words (null when it cannot); without it an `env -S` makes the head opaque.
 */
export function unwrap(words: Word[], split: (s: string) => Word[] | null = () => null, mods: Mods = noMods()): Word[] {
	let w = words;
	for (let guard = 0; guard < 64; guard++) {
		let k = 0;
		while (k < w.length && !w[k]!.opaque && /^[A-Za-z_]\w*=/.test(w[k]!.text)) mods.assigns.push(w[k++]!);
		w = w.slice(k);
		const head = w[0];
		if (!head || head.opaque || head.glob) return w;
		const name = basename(head.text);
		const wrapper = WRAPPERS[name];
		if (!wrapper) return w;
		let i = 1;
		const flags: string[] = [];
		while (i < w.length && !w[i]!.opaque && w[i]!.text.startsWith("-") && w[i]!.text !== "-") {
			const flag = w[i]!.text;
			flags.push(flag);
			if (name === "env") {
				const s = envSplitString(flag);
				if (s) {
					const value = s.attached !== undefined ? { text: s.attached, opaque: false } : w[i + 1];
					if (!value || value.opaque) return OPAQUE_HEAD;
					const words2 = split(value.text);
					if (words2 === null) return OPAQUE_HEAD;
					// env splits the string into arguments in place, then keeps parsing options.
					w = [...w.slice(0, i), ...words2, ...w.slice(i + (s.attached !== undefined ? 1 : 2))];
					continue;
				}
			}
			i += wrapper.valueFlags.test(flag) ? 2 : 1;
			if (flag === "--") break;
		}
		// `env` takes assignments after its flags.
		if (name === "env") while (i < w.length && !w[i]!.opaque && /^[A-Za-z_]\w*=/.test(w[i]!.text)) mods.assigns.push(w[i++]!);
		mods.wrappers.push([name, ...flags].join(" "));
		w = w.slice(i + wrapper.operands);
	}
	return OPAQUE_HEAD;
}

/** An `env` flag that splits a string (`-S`, `-S'…'`, `-iS`, `--split-string[=…]`): its attached value, if any. */
function envSplitString(flag: string): { attached?: string } | null {
	if (flag === "--split-string") return {};
	if (flag.startsWith("--split-string=")) return { attached: flag.slice("--split-string=".length) };
	if (flag.startsWith("--") || !flag.startsWith("-")) return null;
	for (let k = 1; k < flag.length; k++) {
		const c = flag[k]!;
		if (c === "S") return k + 1 < flag.length ? { attached: flag.slice(k + 1) } : {};
		if ("uCP".includes(c)) return null; // takes the rest of the cluster (or the next word) as its value
	}
	return null;
}

function readScript(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const st = statSync(path);
		if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return null;
		const body = readFileSync(path, "utf8");
		return body.includes("\0") ? null : body;
	} catch {
		return null;
	}
}

const joined = (words: Word[]): string => words.map((w) => w.text).join(" ");
const unknown = (w: Word | undefined): boolean => !w || w.opaque || w.glob === true;

/**
 * Backslash escapes as `echo -e` (and, with `bareOctal`, `printf %b`) read them; `\c` ends the
 * output. echo takes octal only as `\0NNN`; bash's `%b` also takes `\NNN`, one to three octal digits
 * starting 1-7 (astra-5 R5-B1; measured on /bin/bash 3.2.57: `\147it` → `git`, `\0147` → `g`,
 * `\1471` → `g1`, `\400` → a NUL byte, so a value keeps its low eight bits).
 */
function echoEscapes(s: string, bareOctal = false): { text: string; stop: boolean } {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (c !== "\\" || i + 1 >= s.length) {
			out += c;
			continue;
		}
		const n = s[i + 1]!;
		const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
		if (n === "c") return { text: out, stop: true };
		if (simple[n] !== undefined) {
			out += simple[n];
			i++;
			continue;
		}
		const oct = /^0([0-7]{0,3})/.exec(s.slice(i + 1)) ?? (bareOctal ? /^()([1-7][0-7]{0,2})/.exec(s.slice(i + 1)) : null);
		const hex = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(i + 1));
		if (oct) {
			const digits = oct[1] || oct[2] || "0";
			out += String.fromCharCode(parseInt(digits, 8) & 0xff);
			i += oct[0].length;
		} else if (hex) {
			out += String.fromCharCode(parseInt(hex[1]!, 16));
			i += hex[0].length;
		} else out += c;
	}
	return { text: out, stop: false };
}

/** Escapes in a printf format string (`\NNN` octal without the leading 0 as well). */
function formatEscapes(s: string): string {
	return s.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|.)/g, (m, e: string) => {
		if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
		if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
		if (e[0] === "u" && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
		const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", '"': '"', "'": "'" };
		return simple[e] ?? m;
	});
}

/**
 * What `printf FORMAT ARGS…` writes, as bash's printf computes it (the format reused while arguments
 * remain), or null for a conversion the gate does not evaluate: the caller fails closed.
 * Evaluated: `%s %b %c %d %i %o %u %x %X %%` with the `-` flag, `0` on integers, width (literal or
 * `*`), precision on `%s`/`%b`, and backslash escapes in the format. Not evaluated (null, fail
 * closed): `%q`, `%Q`, every float (`%f %e %g %a` and upper case), `%(…)T`, any other conversion
 * letter, the `+`, space and `#` flags, `0` on `%s %b %c`, precision on an integer conversion,
 * `%o %u %x %X` of a negative number, `%c` of a non-ASCII character, `\c` in the format, a width on
 * an empty or missing `%b` argument, and a format starting with `-` without `--`. Each was measured
 * against /bin/bash 3.2.57 in M4 fix round 4 printing something this function would not (`% d` 0 →
 * ` 0`, `%.3d` 5 → `005`, `%x` -1 → `ffffffffffffffff`, `%04s` 7 → `0007`, `a\cb` → `a\cb`,
 * `%4b` → nothing, `-Z` → an option error). One deviation remains: width counts UTF-16 units where
 * bash counts bytes, so a non-ASCII value gets more padding spaces here; the words are the same.
 * gates/test/printf-property.test.ts compares it against real `bash -c 'printf …'` over random
 * ASCII formats and arguments; it passed on five seeds.
 */
export function printfOutput(args: string[]): string | null {
	let a = args;
	if (a[0] === "--") a = a.slice(1);
	const fmt = a[0];
	// A format starting with `-` is read by printf as an option unless `--` came first.
	if (fmt === undefined || (a === args && fmt.startsWith("-"))) return null;
	const rest = a.slice(1);
	let idx = 0;
	let out = "";
	const next = (): string => rest[idx++] ?? "";
	const num = (s: string): number | null => {
		if (s === "") return 0;
		if (/^['"]/.test(s)) return s.codePointAt(1) ?? 0;
		const n = Number(s);
		return Number.isFinite(n) ? Math.trunc(n) : null;
	};
	for (let pass = 0; pass < 1000; pass++) {
		const before = idx;
		for (let i = 0; i < fmt.length; i++) {
			const c = fmt[i]!;
			if (c === "\\") {
				const m = /^\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|.)/.exec(fmt.slice(i));
				if (!m) {
					out += c;
					continue;
				}
				// `\c` in the format itself: bash 3.2 prints it literally; not evaluated.
				if (m[1] === "c") return null;
				out += formatEscapes(m[0]);
				i += m[0].length - 1;
				continue;
			}
			if (c !== "%") {
				out += c;
				continue;
			}
			const m = /^%([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*)?)?([a-zA-Z%])/.exec(fmt.slice(i));
			if (!m) return null;
			// `+`, space and `#` change the printed text (`% d` 0 prints ` 0`, which can split a word);
			// the gate does not evaluate them.
			if (/[+ #]/.test(m[1]!)) return null;
			// `0` on a string conversion zero-pads it in bash 3.2 (`%04s` 7 → `0007`); not evaluated.
			if (m[1]!.includes("0") && "sbc".includes(m[4]!)) return null;
			i += m[0].length - 1;
			const conv = m[4]!;
			if (conv === "%") {
				out += "%";
				continue;
			}
			const width = m[2] === "*" ? num(next()) : m[2] ? Number(m[2]) : 0;
			const prec = m[3] === "*" ? num(next()) : m[3] !== undefined ? Number(m[3]) : null;
			if (width === null) return null;
			let v: string;
			if (conv === "s") v = next();
			else if (conv === "b") {
				// An empty or missing `%b` argument prints nothing in bash 3.2, width included; not evaluated.
				if ((rest[idx] ?? "") === "" && width !== 0) return null;
				const e = echoEscapes(next(), true);
				v = e.text;
				if (e.stop) return out + v;
			} else if (conv === "c") {
				v = next().slice(0, 1);
				if (v > "\u007f") return null;
			} else if ("diouxX".includes(conv)) {
				const n = num(next());
				if (n === null) return null;
				// Precision on an integer zero-pads, and unsigned conversions of a negative wrap to
				// 2^64; neither is evaluated.
				if (prec !== null || (n < 0 && conv !== "d" && conv !== "i")) return null;
				v = conv === "o" ? n.toString(8) : conv === "x" ? n.toString(16) : conv === "X" ? n.toString(16).toUpperCase() : String(n);
			} else return null;
			if (prec !== null && "sb".includes(conv)) v = v.slice(0, prec);
			const pad = Math.abs(width) - v.length;
			if (pad > 0) v = m[1]!.includes("-") || width < 0 ? v + " ".repeat(pad) : (m[1]!.includes("0") && !"sbc".includes(conv) ? "0" : " ").repeat(pad) + v;
			out += v;
		}
		if (idx === before || idx >= rest.length) break;
	}
	return out;
}

/**
 * What a short option letter does to the words after it, per interpreter family:
 * - `code`: its program text is the rest of the cluster, or else the next word;
 * - `valueNext`: it takes a value, the rest of the cluster or else the next word (not code);
 * - `load`: as `valueNext`, and the value is a module file loaded before the program (node/bun `-r`, ruby `-r`);
 * - `cwd`: as `valueNext`, and the value is the directory the program runs from (ruby `-C`);
 * - `valueAttached`: it takes a value only from the rest of its cluster, so the next word is free;
 * - `module`: a module runs (python `-m`), so the program is not read from stdin.
 * A letter not listed is a flag with no value. Sources: `node --help`, `bun --help`, `python3
 * --help`, perlrun(1), `ruby --help`, `php --help`, osascript(1).
 */
type OptRole = "code" | "valueNext" | "load" | "cwd" | "valueAttached" | "module";
const INTERPRETER_SHORT_OPTS: Record<CodeFamily, Record<string, OptRole>> = {
	js: {
		e: "code", // node/bun -e <script>
		p: "code", // -p <script>: evaluate and print
		r: "load", // -r <module>: preload
		C: "valueNext", // -C <condition>: export conditions
		F: "valueNext", // bun -F <pattern>: workspace filter
		d: "valueNext", // bun -d <K:V>: define
		l: "valueNext", // bun -l <.ext:loader>
	},
	python: {
		c: "code", // -c <command>
		W: "valueNext", // -W <warning filter>
		X: "valueNext", // -X <implementation option>
		Q: "valueNext", // -Q <division> (Python 2)
		m: "module", // -m <module>
	},
	perl: {
		e: "code", // -e <line>
		E: "code", // -E <line>, with optional features on
		I: "valueAttached", // -I<dir>: include path
		M: "valueAttached", // -M<module>: use module
		m: "valueAttached", // -m<module>: use module, no import
		i: "valueAttached", // -i[ext]: edit in place
		0: "valueAttached", // -0[octal]: record separator
		l: "valueAttached", // -l[octal]: line ending
		x: "valueAttached", // -x[dir]: skip leading garbage
		C: "valueAttached", // -C[number/list]: Unicode features
		d: "valueAttached", // -d[:mod]: debugger
		D: "valueAttached", // -D[number/list]: debugging flags
		V: "valueAttached", // -V[:configvar]: print config
	},
	ruby: {
		e: "code", // -e <line>
		r: "load", // -r <library>
		I: "valueNext", // -I <directory>
		C: "cwd", // -C <directory>: cd first
		E: "valueNext", // -E <ext:int>: encodings
		F: "valueNext", // -F <pattern>: split separator
		K: "valueAttached", // -K<kcode>
		W: "valueAttached", // -W[level]: warning level
		T: "valueAttached", // -T[level]: taint (old rubies)
		x: "valueAttached", // -x[directory]
		0: "valueAttached", // -0[octal]: record separator
		l: "valueAttached", // -l: line ending processing
		i: "valueAttached", // -i[extension]: edit in place
	},
	php: {
		r: "code", // -r <code>
		R: "code", // -R <code>: per input line
		B: "code", // -B <begin_code>
		E: "code", // -E <end_code>
		d: "valueNext", // -d foo[=bar]: ini entry
		c: "valueNext", // -c <path>: php.ini
		f: "valueNext", // -f <file>
		z: "valueNext", // -z <file>: Zend extension
	},
	osascript: {
		e: "code", // -e <statement>
		l: "valueNext", // -l <language>
		s: "valueNext", // -s <flags>: output style
	},
};

/** Deno's short options (`deno run --help`, deno 2.9.4): `-r` is `--reload`, a flag, not a preload. */
const DENO_SHORT_OPTS: Record<string, OptRole> = { c: "valueNext", L: "valueNext" };

/** How an interpreter's long options read the words after them. A long option not matched is a flag with no value. */
interface LongOpts {
	/** Its program text is the next word (`--eval code`), or the text after `=`. */
	code: RegExp;
	/** It takes the next word as a value (`--title x`); `--name=value` takes none. */
	value: RegExp;
	/** Its value is a module file loaded before the program (`--preload f`, `--import=f`). */
	load: RegExp;
	/** Its value is the directory the program runs from (bun `--cwd`). */
	cwd: RegExp;
}

/**
 * The long options that take a separate value word: node's (`node --help`, v24.13.0) and bun's (`bun --help`, `bun run
 * --help`, 1.3.14) that print as `--name=…` / `--name=<val>`, and python's `--check-hash-based-pycs`. bun's
 * `--config`/`-c` and `--inspect*` take a value only after `=` (live, bun 1.3.14, 2026-10-19: `bun --config a.ts b.ts`
 * runs a.ts), so they are flags here.
 */
const LONG_VALUE = new RegExp(
	`^--(?:${[
		"input-type conditions env-file env-file-if-exists title port console-depth define tsconfig-override install shell filter elide-lines",
		"cpu-prof-name cpu-prof-dir cpu-prof-interval heap-prof-name heap-prof-dir heap-prof-interval fetch-preconnect max-http-header-size",
		"dns-result-order unhandled-rejections user-agent cron-title cron-period main-fields extension-order drop feature jsx-factory",
		"jsx-fragment jsx-import-source jsx-runtime run allow-fs-read allow-fs-write build-snapshot-config diagnostic-dir disable-proto",
		"disable-warning experimental-config-file experimental-sea-config heapsnapshot-near-heap-limit heapsnapshot-signal icu-data-dir",
		"inspect-publish-uid localstorage-file max-old-space-size-percentage network-family-autoselection-attempt-timeout openssl-config",
		"redirect-warnings report-filename report-signal secure-heap secure-heap-min snapshot-blob test-concurrency test-coverage-branches",
		"test-coverage-exclude test-coverage-functions test-coverage-include test-coverage-lines test-global-setup test-name-pattern",
		"test-reporter test-reporter-destination test-rerun-failures test-shard test-skip-pattern test-timeout tls-cipher-list tls-keylog",
		"trace-event-categories trace-event-file-pattern trace-require-module use-largepages watch-kill-signal watch-path check-hash-based-pycs",
	]
		.join(" ")
		.split(" ")
		.join("|")})$`,
);
const INTERPRETER_LONG_OPTS: LongOpts = { code: /^--(?:eval|print)$/, value: LONG_VALUE, load: /^--(?:require|import|preload|loader|experimental-loader)$/, cwd: /^--cwd$/ };
/** Deno's long options with a value (`deno run --help`, deno 2.9.4); `--env-file`, `--reload`, `--inspect*` take one only after `=`. */
const DENO_LONG_OPTS: LongOpts = {
	code: /^$/,
	value: /^--(?:cert|conditions|config|cpu-prof-dir|cpu-prof-interval|cpu-prof-name|ext|location|minimum-dependency-age|seed|import-map|log-level)$/,
	load: /^--(?:preload|require)$/,
	cwd: /^$/,
};
/** Deno's subcommands other than `run`, `serve` and `watch` (`deno --help`, deno 2.9.4): none runs a file the gate reads. */
const DENO_SUBCOMMANDS: Record<string, true> = Object.fromEntries(
	"task repl eval add bump-version install ci uninstall outdated list approve-scripts remove link unlink publish why bench check clean compile coverage deploy doc fmt info jupyter lint init test pack upgrade completions types help vendor cache bundle x"
		.split(" ")
		.map((n) => [n, true]),
);

/** What an interpreter's argv runs as program text: inline code words, whether it reads its program from stdin, and the file it runs. */
export interface InterpreterArgs {
	code: Word[];
	stdin: boolean;
	/** An argument the gate cannot read where it could be a code flag or the program. */
	unknown: boolean;
	/**
	 * Where the program file sits in `args`: the first operand, or the word after `--`, when no inline code, stdin or
	 * module (python `-m`) runs instead; -1 otherwise. For bun it may name a subcommand (`run`, `test`, `x`).
	 */
	operand: number;
	/** Module files an option loads before the program (`-r`, `--require`, `--import`, `--preload`, `--loader`, …). */
	loads: Word[];
	/** The directory an option runs the program from (bun `--cwd`, ruby `-C`); the last one wins. */
	cwd: Word | null;
}

export function interpreterArgs(family: CodeFamily, name: string, args: Word[]): InterpreterArgs {
	const out: InterpreterArgs = { code: [], stdin: false, unknown: false, operand: -1, loads: [], cwd: null };
	if (name === "deno") {
		const sub = args[0]?.text;
		if (sub === "eval") {
			const code = args.slice(1).find((w) => unknown(w) || !w.text.startsWith("-"));
			if (!code || unknown(code)) out.unknown = true;
			else out.code.push(code);
			return out;
		}
		// `deno run|serve|watch [options] <file>`, or Deno 2's `deno [options] <file>`; another subcommand runs no file the gate reads.
		const start = sub === "run" || sub === "serve" || sub === "watch" ? 1 : 0;
		if (start === 0 && sub !== undefined && !unknown(args[0]) && Object.hasOwn(DENO_SUBCOMMANDS, sub)) return out;
		scanOptions(DENO_SHORT_OPTS, DENO_LONG_OPTS, family, args, start, out);
		out.stdin = sub === "run" && args.some((w) => w.text === "-");
		return out;
	}
	scanOptions(INTERPRETER_SHORT_OPTS[family], INTERPRETER_LONG_OPTS, family, args, 0, out);
	return out;
}

/** Read `args` from `start` as an interpreter's options, up to its program (interpreterArgs). */
function scanOptions(short: Record<string, OptRole>, long: LongOpts, family: CodeFamily, args: Word[], start: number, out: InterpreterArgs): void {
	for (let i = start; i < args.length; i++) {
		const w = args[i]!;
		if (unknown(w)) {
			out.unknown = true;
			return;
		}
		const t = w.text;
		if (t === "-") {
			out.stdin = out.code.length === 0;
			return;
		}
		if (t === "--") {
			if (out.code.length === 0) {
				if (i + 1 >= args.length) out.stdin = true;
				else out.operand = i + 1;
			}
			return;
		}
		if (family === "js" && long.code.test(t)) {
			const code = args[++i];
			if (unknown(code)) out.unknown = true;
			else out.code.push(code!);
			continue;
		}
		if (family === "js" && /^--(eval|print)=/.test(t) && long.code.test(t.slice(0, t.indexOf("=")))) {
			out.code.push({ text: t.slice(t.indexOf("=") + 1), opaque: false });
			continue;
		}
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const opt = eq < 0 ? t : t.slice(0, eq);
			const isLoad = long.load.test(opt);
			const isCwd = long.cwd.test(opt);
			if (!isLoad && !isCwd && !long.value.test(opt)) continue;
			const value = eq < 0 ? args[++i] : { text: t.slice(eq + 1), opaque: false };
			if (value && isLoad) out.loads.push(value);
			if (value && isCwd) out.cwd = value;
			continue;
		}
		if (t.startsWith("-")) {
			for (let k = 1; k < t.length; k++) {
				const c = t[k]!;
				const role = short[c];
				if (role === "code") {
					const attached = t.slice(k + 1);
					if (attached !== "") out.code.push({ text: attached, opaque: false });
					else {
						const code = args[++i];
						if (unknown(code)) out.unknown = true;
						else out.code.push(code!);
					}
					break;
				}
				if (role === "module") return; // python -m: a module runs, not stdin
				if (role === "valueNext" || role === "load" || role === "cwd") {
					const value = k + 1 >= t.length ? args[++i] : { text: t.slice(k + 1), opaque: false };
					if (value && role === "load") out.loads.push(value);
					if (value && role === "cwd") out.cwd = value;
					break;
				}
				if (role === "valueAttached") break;
			}
			// python's -c ends option parsing: what follows is the program's argv.
			if (family === "python" && out.code.length > 0) return;
			continue;
		}
		// The first operand: a script (or bun subcommand) when there is no inline code, else the code's argv.
		if (out.code.length === 0) out.operand = i;
		return;
	}
	if (out.code.length === 0) out.stdin = true;
}

class Expander {
	readonly out: Expansion = { commands: [], code: [], blind: [], assigned: new Map() };
	/** Files the command writes (redirects, tee, cp/mv/ln/install destinations) before it runs a later script. */
	private readonly written = new Set<string>();
	private unknownWrite = false;

	constructor(readonly env: Record<string, string | undefined>) {}

	/** Parse and expand `src`. `spans` is set only for the tool's own command at depth 0 (Word.span; row 6 masks data words by it). */
	shell(src: string, dir: string, depth: number, vars?: Map<string, VarValue>, spans = false): void {
		if (depth > MAX_DEPTH) {
			this.out.blind.push(`commands nested more than ${MAX_DEPTH} levels deep`);
			return;
		}
		const opts: ParseOptions = { cwd: dir, env: this.env, spans };
		const r = parseShell(src, opts, vars);
		for (const f of r.failures) this.out.blind.push(`the command could not be parsed (${f})`);
		for (const cmd of r.commands) {
			this.recordAssigns(cmd.words);
			const mods = noMods();
			this.command(cmd, this.unwrapAt(cmd.words, cmd.dir, mods), depth, mods);
		}
	}

	private unwrapAt(words: Word[], dir: string, mods: Mods = noMods()): Word[] {
		return unwrap(words, (s) => this.splitWords(s, dir), mods);
	}

	/** Statement-level assignments: `NAME=v;` and `export`/`declare`/`local`/`readonly`/`typeset NAME[=v]`. */
	private recordAssigns(words: Word[]): void {
		let k = 0;
		while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k]!.text)) this.assign(words[k++]!);
		const head = words[k];
		if (!head || head.opaque || !/^(export|declare|local|readonly|typeset)$/.test(head.text)) return;
		for (const w of words.slice(k + 1)) if (/^[A-Za-z_]\w*(=|$)/.test(w.text)) this.assign(w);
	}

	private assign(w: Word): void {
		const eq = w.text.indexOf("=");
		const name = eq < 0 ? w.text : w.text.slice(0, eq);
		const seen = this.out.assigned.get(name);
		// `export NAME` after `NAME=v` exports that value: the word that carries it is already judged.
		if (seen && (eq < 0 || seen.includes(w))) return;
		if (seen) seen.push(w);
		else this.out.assigned.set(name, [w]);
	}

	/** One command line's words, with no operators or redirects (an `env -S` string); null when it has any. */
	private splitWords(text: string, dir: string): Word[] | null {
		const r = parseShell(text, { cwd: dir, env: this.env });
		if (r.failures.length > 0 || r.commands.length > 1 || r.ops.length > 0 || r.keywords.length > 0) return null;
		const c = r.commands[0];
		if (!c) return [];
		return c.redirects.length > 0 ? null : c.words;
	}

	private script(path: string, via: string, depth: number): void {
		if (this.written.has(path) || this.unknownWrite) {
			this.out.blind.push(`${via} runs ${path}, which this same command may write before it runs`);
			return;
		}
		if (!existsSync(path)) {
			this.out.blind.push(`${via} runs ${path}, which does not exist when the gate reads it`);
			return;
		}
		const body = readScript(path);
		if (body !== null) this.shell(body, resolve(path, ".."), depth + 1);
		else this.out.blind.push(`${via} runs ${path}, which could not be read as a script`);
	}

	/** A file read as program text for an interpreter; null (and blind) when it cannot be read. */
	private codeFile(path: string, via: string): string | null {
		if (this.written.has(path) || this.unknownWrite) {
			this.out.blind.push(`${via} reads ${path}, which this same command may write before it runs`);
			return null;
		}
		const body = readScript(path);
		if (body === null) this.out.blind.push(`${via} reads program text from ${path}, which could not be read`);
		return body;
	}

	/** Record what this command writes, for a later script run in the same command string. */
	private recordWrites(src: SimpleCommand, argv: Word[], dir: string): void {
		const add = (w: Word | undefined): void => {
			if (!w) return;
			if (unknown(w)) {
				this.unknownWrite = true;
				return;
			}
			const p = resolve(dir, w.text);
			this.written.add(p);
		};
		for (const r of src.redirects) if (r.op.includes(">") && r.op !== ">&" && r.target) add(r.target);
		const head = argv[0];
		if (!head || unknown(head)) return;
		const name = basename(head.text);
		const operands = argv.slice(1).filter((w) => unknown(w) || !w.text.startsWith("-"));
		if (name === "tee") for (const w of operands) add(w);
		if (name === "cp" || name === "mv" || name === "ln" || name === "install") add(operands.at(-1));
		if (name === "curl" || name === "wget") {
			const i = argv.findIndex((w) => /^(-o|--output|-O|--output-document)$/.test(w.text));
			if (i > 0) add(argv[i + 1]);
		}
	}

	/** One command (already unwrapped) and everything it runs. */
	command(src: SimpleCommand, argv: Word[], depth: number, mods: Mods = noMods()): void {
		if (argv.length === 0) return;
		const dir = src.dir;
		for (const a of mods.assigns) this.assign(a);
		this.out.commands.push({ argv, redirects: src.redirects, dir, dirKnown: src.dirKnown, source: src, mods });
		this.recordWrites(src, argv, dir);
		const head = argv[0]!;
		if (head.opaque) {
			this.out.blind.push("the command name is not known until it runs (a substitution or unset variable)");
			return;
		}
		if (head.glob) {
			this.out.blind.push(`the command name \`${head.text}\` is a glob pattern the shell expands when it runs`);
			return;
		}
		if (depth > MAX_DEPTH) {
			this.out.blind.push(`commands nested more than ${MAX_DEPTH} levels deep`);
			return;
		}
		const name = basename(head.text);
		const args = argv.slice(1);

		if (SHELLS[name]) return this.shellCommand(src, name, args, dir, depth);
		if (name === "source" || name === ".") {
			const target = args[0];
			if (unknown(target)) this.out.blind.push(`\`${name}\` of a path not known until it runs`);
			else this.script(resolve(dir, target!.text), name, depth);
			return;
		}
		if (name === "eval") {
			if (args.some((a) => unknown(a))) this.out.blind.push("`eval` of text not known until it runs");
			this.shell(joined(args), dir, depth + 1);
			return;
		}
		if (name === "xargs") return this.xargs(src, args, depth);
		if (name === "find") return this.findExec(src, args, depth);
		// git runs nothing the expander follows: an alias (`-c alias.*`, or a subcommand that is not
		// git's own) is refused by gitUnmodeled rather than expanded (M4 fix round 4, B1).
		if (name === "git") return;
		const family = interpreterFamily(name);
		if (family) return this.interpreter(src, name, family, args, dir);
		if (head.text.includes("/") && !SYSTEM_BIN.test(resolve(dir, head.text))) this.script(resolve(dir, head.text), head.text, depth);
	}

	private interpreter(src: SimpleCommand, name: string, family: CodeFamily, args: Word[], dir: string): void {
		const a = interpreterArgs(family, name, args);
		if (a.unknown) this.out.blind.push(`\`${name}\` with code or an argument not known until it runs`);
		for (const c of a.code) this.out.code.push({ lang: name, family, text: c.text, dir });
		if (!a.stdin) return;
		// The program comes from stdin: a heredoc, a file, or a pipe (astra review round 2: a produced-then-piped program).
		for (const s of this.stdinSources(src, name, dir)) {
			if ("text" in s) this.out.code.push({ lang: name, family, text: s.text, dir });
			else {
				const body = this.codeFile(s.path, s.via);
				if (body !== null) this.out.code.push({ lang: name, family, text: body, dir });
			}
		}
	}

	/**
	 * What a command reads on stdin as program text: heredoc/herestring bodies, `<` files, and a pipe
	 * from a producer whose output the gate can compute. Unknown input is pushed as blind. `required`
	 * (a shell) also treats no stdin at all as blind.
	 */
	private stdinSources(src: SimpleCommand, name: string, dir: string, required = false): Array<{ text: string } | { path: string; via: string }> {
		const out: Array<{ text: string } | { path: string; via: string }> = [];
		const stdin = src.redirects.filter((r) => r.op === "<<" || r.op === "<<-" || r.op === "<<<" || r.op === "<");
		for (const r of stdin) {
			if (r.op === "<") {
				if (unknown(r.target ?? undefined)) this.out.blind.push(`\`${name}\` reads its program from a path not known until it runs`);
				else out.push({ path: resolve(dir, r.target!.text), via: name });
			} else {
				if (r.bodyOpaque) this.out.blind.push(`\`${name}\` reads a heredoc whose text is not known until it runs`);
				out.push({ text: r.body ?? "" });
			}
		}
		if (stdin.length > 0) return out;
		const producer = src.stdinFrom;
		if (!producer) {
			if (required) this.out.blind.push(`\`${name}\` reads commands from stdin the gate cannot see`);
			return out;
		}
		const p = this.unwrapAt(producer.words, producer.dir);
		const pName = p[0] && !unknown(p[0]) ? basename(p[0].text) : "";
		const words = p.slice(1);
		if (pName === "echo") {
			let k = 0;
			while (k < words.length && /^-[neE]+$/.test(words[k]!.text)) k++;
			const rest = words.slice(k);
			if (rest.some((w) => unknown(w))) this.out.blind.push(`\`echo … | ${name}\` pipes text not known until it runs`);
			const plain = joined(rest);
			// echo interprets backslash escapes in some shells and with -e: read both spellings.
			out.push({ text: plain });
			if (plain.includes("\\")) out.push({ text: echoEscapes(plain).text });
		} else if (pName === "printf") {
			const text = words.some((w) => unknown(w)) ? null : printfOutput(words.map((w) => w.text));
			if (text === null) this.out.blind.push(`\`printf … | ${name}\` pipes output the gate cannot compute`);
			else out.push({ text });
		} else if (pName === "cat" && p.length > 1) {
			for (const w of words) {
				if (unknown(w)) this.out.blind.push(`\`cat … | ${name}\` pipes a path not known until it runs`);
				else if (!w.text.startsWith("-")) out.push({ path: resolve(producer.dir, w.text), via: `cat | ${name}` });
			}
		} else if (pName === "cat" && producer.redirects.some((r) => r.body !== null)) {
			for (const r of producer.redirects) if (r.body !== null) out.push({ text: r.body });
		} else {
			this.out.blind.push(`\`${name}\` runs commands piped from \`${pName || "an unknown command"}\`, which the gate cannot see`);
		}
		return out;
	}

	private shellCommand(src: SimpleCommand, name: string, args: Word[], dir: string, depth: number): void {
		let cMode = false;
		let noExec = false;
		let i = 0;
		for (; i < args.length; i++) {
			const a = args[i]!;
			// An option word the gate cannot read may be the `+n` that turns execution back on.
			if (unknown(a)) {
				noExec = false;
				break;
			}
			if (a.text === "--") {
				i++;
				break;
			}
			if (!a.text.startsWith("-") && !a.text.startsWith("+")) break;
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a.text)) cMode = true;
			// noexec in option order: a standalone `-n` turns it on; `+n` (alone or in a `+` cluster) and
			// `+o noexec` turn it off again, so the script or stdin runs (PR #49 review, B2; live,
			// 2026-10-11, bash 3.2.57 and zsh: `-n +n` and `-n +o noexec` ran the stdin commands).
			// `-o noexec` is not a shortcut: the execution model stays for it (conservative).
			// zsh reads option names case-insensitively and without underscores, and has the positive
			// `exec`: `+o no_exec`, `+o NOEXEC`, `-o exec` and `--exec` all ran after `-n` (review round 2,
			// N2, live zsh -f). Any option word the gate does not know to leave execution alone ends the
			// shortcut, so the script or stdin is judged (fail closed: inspected, not blind).
			if (a.text === "-n") noExec = true;
			else if (/^\+[A-Za-z]*n/.test(a.text)) noExec = false;
			else if (a.text === "-o" || a.text === "+o") {
				const value = args[i + 1];
				i++;
				if (!value || unknown(value)) noExec = false;
				else {
					const opt = value.text.toLowerCase().replaceAll("_", "");
					const clears = (a.text === "+o" && opt === "noexec") || (a.text === "-o" && opt === "exec");
					const keeps = opt === "noexec" || opt === "exec" || NOEXEC_NEUTRAL_OPTION.test(opt);
					if (clears || !keeps) noExec = false;
				}
			} else if (a.text === "-O" || a.text === "+O" || a.text === "--rcfile" || a.text === "--init-file") {
				noExec = false;
				i++;
			} else if (!NOEXEC_NEUTRAL_WORD.test(a.text)) noExec = false;
		}
		const first = args[i];
		if (cMode) {
			if (unknown(first)) this.out.blind.push(`\`${name} -c\` with a script not known until it runs`);
			else this.shell(first!.text, dir, depth + 1);
			return;
		}
		// A standalone `-n` before the script, not turned off by a later option: the shell reads it (or
		// stdin) for syntax and runs nothing (live, 2026-10-11, bash 3.2.57, zsh, sh, ksh: `<shell> -n
		// script` printed nothing and exited 0). The script stays in argv as a path the command reads,
		// so a row judging reads (row 10, the ledger file) still sees it; its contents are not commands
		// of this call (guard-replay drift triage: `zsh -n run-proof.sh` was refused for an export
		// inside the script). `-n` in a cluster (`-xn`) or with `-c` keeps the execution model: fail
		// closed on what is not spelled plainly.
		if (noExec) return;
		if (first) {
			if (unknown(first)) this.out.blind.push(`\`${name}\` runs a script path not known until it runs`);
			else this.script(resolve(dir, first.text), name, depth);
			return;
		}
		// No script argument: the shell reads commands from stdin.
		for (const s of this.stdinSources(src, name, dir, true)) {
			if ("text" in s) this.shell(s.text, dir, depth + 1);
			else this.script(s.path, s.via, depth);
		}
	}

	/** `xargs [flags] cmd args…`: cmd runs with extra arguments from stdin, unknown here. */
	private xargs(src: SimpleCommand, args: Word[], depth: number): void {
		let i = 0;
		while (i < args.length && !args[i]!.opaque && args[i]!.text.startsWith("-")) {
			const f = args[i]!.text;
			i += /^-[IELnPsda]$/.test(f) || /^--(?:replace|eof|max-lines|max-args|max-procs|max-chars|delimiter|arg-file)$/.test(f) ? 2 : 1;
		}
		const inner = args.slice(i);
		if (inner.length === 0) inner.push({ text: "echo", opaque: false });
		const mods = noMods();
		this.command(src, this.unwrapAt([...inner, { text: "", opaque: true }], src.dir, mods), depth + 1, { ...mods, wrappers: ["xargs", ...mods.wrappers] });
	}

	/** `find … -exec cmd … ;` (and -execdir, -ok, -okdir). */
	private findExec(src: SimpleCommand, args: Word[], depth: number): void {
		for (let i = 0; i < args.length; i++) {
			if (!/^-(exec|execdir|ok|okdir)$/.test(args[i]!.text)) continue;
			const end = args.findIndex((a, k) => k > i && (a.text === ";" || a.text === "+"));
			const inner = args.slice(i + 1, end < 0 ? undefined : end).map((w) => (w.text === "{}" ? { text: "", opaque: true } : w));
			const mods = noMods();
			this.command(src, this.unwrapAt(inner, src.dir, mods), depth + 1, { ...mods, wrappers: [`find ${args[i]!.text}`, ...mods.wrappers] });
			if (end < 0) break;
			i = end;
		}
	}
}

/**
 * Everything `command` runs, from `cwd`, as far as the gate can see. `toolEnv` is the bash tool's own
 * `env` input (variables it adds for the call): each is judged as an assignment every command
 * reaches (astra-8 P15), a value that is not a string as one not typed out as literal text.
 */
export function expandShell(command: string, cwd: string, env: Record<string, string | undefined>, toolEnv?: unknown): Expansion {
	const e = new Expander(env);
	if (toolEnv && typeof toolEnv === "object") {
		for (const [name, value] of Object.entries(toolEnv)) {
			if (/^[A-Za-z_]\w*$/.test(name)) e.out.assigned.set(name, [{ text: `${name}=${typeof value === "string" ? value : ""}`, opaque: typeof value !== "string" }]);
		}
	}
	e.shell(command, cwd, 0, undefined, true);
	return e.out;
}

/** Text of an Exec for the regex rules: argv joined by single spaces. */
export function execText(e: Exec): string {
	return joined(e.argv);
}

/** A copy of the M4b fence's wrapper, taken apart: the Seatbelt profile and the command it runs. */
export interface CopiedWrapper {
	profile: string;
	command: string;
}

/**
 * A carriage return stands in for this while a copied wrapper is parsed, and is put back after:
 * parseShell reads `\r\n?` as `\n` (shell-parse.ts parseShell), which would hand the fence a
 * different inner command from the one the model wrote (item 65 review S2). Private use, so no
 * command the gate has seen carries it; one that does is not taken apart.
 */
const CR_STAND_IN = "\uE000";

/**
 * The fence's own wrapper (fence.ts wrapCommand: `'<sandbox-exec>' -p '<profile>' /bin/bash -c
 * '<command>'`) taken apart, or null for anything else. OMP persists the fence's revision as the
 * call's own arguments, so a bash call's recorded input (a `tool_result`'s, a transcript's) can carry
 * the wrapper, and the rows judge the inner command (bashCommand). A copy the model types is not
 * judged here: P-11 row 18 (rows/r18-typed-wrapper.ts) reads the raw typed text, refuses it before
 * any other row, and names this inner command in its refusal; the fence no longer strips a copy
 * (MIGRATION.md item 99, superseding item 77's strip). Only that shape counts, up to the basename
 * of the two programs: one simple command of six literal words, no redirect, pipe, list or
 * expansion. One level is taken off, never two: a `sandbox-exec` left in the inner command is a
 * wrapper the expander follows (WRAPPERS), row 6 refuses by name, and the fence refuses too
 * (fence.ts nestedSandboxExec).
 */
export function copiedWrapper(command: string): CopiedWrapper | null {
	if (command.includes(CR_STAND_IN)) return null;
	const p = parseShell(command.replaceAll("\r", CR_STAND_IN), { cwd: "/", env: {} });
	if (p.failures.length > 0 || p.ops.length > 0 || p.keywords.length > 0 || p.commands.length !== 1) return null;
	const c = p.commands[0]!;
	if (c.redirects.length > 0 || c.words.length !== 6 || c.words.some((w) => w.opaque || w.expanded || w.glob)) return null;
	const [exe, dashP, profile, shell, dashC, inner] = c.words.map((w) => w.text.replaceAll(CR_STAND_IN, "\r"));
	if (basename(exe!) !== "sandbox-exec" || dashP !== "-p" || (shell !== "/bin/bash" && shell !== "bash") || dashC !== "-c") return null;
	return { profile: profile!, command: inner! };
}

/** The command a bash call runs, as every row but row 18 judges it: `input.command` with a fence wrapper taken off (the fence's revision on a recorded call; row 18 judges the raw typed text). */
export function bashCommand(input: Record<string, unknown>): string {
	const command = String(input.command ?? "");
	return copiedWrapper(command)?.command ?? command;
}

/**
 * Does `command` run `sandbox-exec` anywhere the expander can see — as a head, under another
 * wrapper, in a subshell, through `eval` or a second shell — by the parsed word, so that quoting
 * (`sand''box-exec`) does not hide it (item 65 review B1)? What the expander cannot see is the
 * rows' blind refusal, not this.
 */
export function nestedSandboxExec(command: string, cwd: string, env: Record<string, string | undefined>, toolEnv?: unknown): boolean {
	return expandShell(command, cwd, env, toolEnv).commands.some((e) => basename(e.argv[0]!.text) === "sandbox-exec" || e.mods.wrappers.some((w) => w.startsWith("sandbox-exec")));
}

/** xxd's options that take a value (`-c 8`, `-c8`, `-cols 8`), by letter, with their long spelling (xxd -h, xxd.c). */
const XXD_VALUE: Record<string, string> = { c: "cols", g: "groupsize", l: "len", n: "name", o: "offset", s: "seek", R: "R" };
/** xxd's options that take none (xxd -h: -a -b -C -d -E -e -h -i -ps -r -u -v, and their long spellings). */
const XXD_FLAG = /^-(?:a(?:utoskip)?|b(?:its)?|C|capitalize|d(?:ecimal)?|e|E(?:BCDIC)?|h(?:elp)?|i(?:nclude)?|p(?:s|lain|ostscript)?|r(?:evert)?|u(?:ppercase)?|v(?:ersion)?)$/;

/**
 * xxd's operands, `xxd [options] [infile [outfile]]` (xxd -h), or null when a word is not one of its
 * options or there are more than two: its second operand is a file it writes, with or without -r
 * (astra-6 B6: `xxd /dev/null <ledger>` truncates the ledger).
 */
function xxdOperands(argv: Word[]): Word[] | null {
	const operands: Word[] = [];
	for (let i = 1; i < argv.length; i++) {
		const w = argv[i]!.text;
		if (w === "--") {
			operands.push(...argv.slice(i + 1));
			break;
		}
		if (!w.startsWith("-") || w === "-") {
			operands.push(argv[i]!);
			continue;
		}
		if (XXD_FLAG.test(w)) continue;
		const long = XXD_VALUE[w[1]!];
		if (long === undefined) return null;
		if (w.length === 2 || w === `-${long}`) {
			if (++i >= argv.length) return null;
			continue;
		}
		if (!/^[-+]?\d/.test(w.slice(2)) && w[1] !== "R" && w[1] !== "n") return null; // `-c8`, `-s+16`: an attached number
	}
	return operands.length <= 2 ? operands : null;
}

/**
 * Read-only commands that may name the ledger file (no redirect into it); row 10 lets them. `cat`
 * through `diff` are the fix-5 additions (fable/Kimi: `cat <ledger>` refused as a write was a defect).
 * A read-only head can still write a file, so each one's output options are modeled here (M4 fix
 * round 7, astra-7 B5), read from its own documentation: xxd's second operand is its output (`xxd -h`);
 * `file -C`/`--compile` writes a compiled magic database in the working directory (file 5.46
 * apprentice.c `apprentice_compile`/`mkdbname`, opened O_WRONLY|O_CREAT|O_TRUNC); none of the others
 * (macOS man pages and `--help`: ls stat du test [ wc shasum sha256sum md5 md5sum realpath readlink
 * cat head tail hexdump od strings cmp diff) documents an option that writes a file. Their derived
 * destinations go through writeDestinations; readHeadUnmodeled refuses the rest.
 */
export const READ_ONLY_HEADS: Record<string, true> = {
	ls: true, stat: true, file: true, du: true, test: true, "[": true, wc: true, shasum: true, sha256sum: true, md5: true, md5sum: true, realpath: true, readlink: true,
	cat: true, head: true, tail: true, hexdump: true, xxd: true, od: true, strings: true, cmp: true, diff: true,
};

/** file 5.46's long options (src/file_opts.h) and whether each takes a value. */
const FILE_LONG: Record<string, boolean> = {
	help: false, version: false, "magic-file": true, uncompress: false, "uncompress-noreport": false, brief: false, "checking-printout": false,
	exclude: true, "exclude-quiet": true, "files-from": true, separator: true, mime: false, apple: false, extension: false, "mime-type": false,
	"mime-encoding": false, "keep-going": false, list: false, dereference: false, "no-dereference": false, "no-buffer": false, "no-pad": false,
	print0: false, "preserve-date": false, parameter: true, raw: false, "special-files": false, "no-sandbox": false, compile: false, debug: false,
};
/** file 5.46's short options (src/file.c OPTSTRING "bcCde:Ef:F:hiklLm:nNpP:rsSvzZ0"): true takes a value. */
const FILE_SHORT: Record<string, boolean> = Object.fromEntries(
	[..."bcCdEhiklLnNprsSvzZ0"].map((c) => [c, false] as [string, boolean]).concat([..."efFmP"].map((c) => [c, true])),
);
/** Short letters and long names that are the same file option. */
const FILE_SHORT_LONG: Record<string, string> = { C: "compile", m: "magic-file", i: "mime" };

/** A long option resolved the way getopt_long reads it: an exact name, else a unique prefix; null when unknown or ambiguous. */
function longOption(name: string, table: Record<string, unknown>): string | null {
	if (name in table) return name;
	const hits = Object.keys(table).filter((k) => k.startsWith(name));
	return hits.length === 1 ? hits[0]! : null;
}

/**
 * `file`'s compile outputs (astra-7 B5), or why the gate cannot derive them. With `-C`, file compiles
 * each `:`-separated component of its magic path to `<basename>.mgc` in the working directory (a name
 * already ending `.mgc` kept as it is; with a MIME flag, `<stem>.mime.mgc` when that exists), per
 * mkdbname. Every word starting with `-` before `--` is read as an option, wherever it sits.
 */
function fileOutputs(e: Exec): { outputs: Word[]; unmodeled: string | null } {
	let compile = false;
	let mime = false;
	let magic: Word | null = null;
	const set = (opt: string, value: Word | undefined): string | null => {
		if (opt === "compile") compile = true;
		else if (opt === "mime" || opt === "mime-type" || opt === "mime-encoding") mime = true;
		else if (opt === "magic-file") {
			if (!value) return "file -m with no magic file after it";
			magic = value;
		}
		return null;
	};
	for (let i = 1; i < e.argv.length; i++) {
		const w = e.argv[i]!;
		if (unknown(w)) return { outputs: [], unmodeled: `file with a word not typed out as literal text (\`${w.text}\`), which may be an option that writes a file` };
		const t = w.text;
		if (t === "--") break;
		if (!t.startsWith("-") || t === "-") continue;
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const opt = longOption(eq < 0 ? t.slice(2) : t.slice(2, eq), FILE_LONG);
			if (opt === null) return { outputs: [], unmodeled: `file ${t}, an option file does not document` };
			const value = FILE_LONG[opt] ? (eq < 0 ? e.argv[++i] : { ...w, text: t.slice(eq + 1) }) : undefined;
			const why = set(opt, value);
			if (why) return { outputs: [], unmodeled: why };
			continue;
		}
		for (let k = 1; k < t.length; k++) {
			const c = t[k]!;
			if (!(c in FILE_SHORT)) return { outputs: [], unmodeled: `file -${c}, an option file does not document` };
			const opt = FILE_SHORT_LONG[c] ?? c;
			if (FILE_SHORT[c]) {
				const value = k + 1 < t.length ? { ...w, text: t.slice(k + 1) } : e.argv[++i];
				const why = set(opt, value);
				if (why) return { outputs: [], unmodeled: why };
				break;
			}
			set(opt, undefined);
		}
	}
	if (!compile) return { outputs: [], unmodeled: null };
	const m = magic as Word | null;
	if (m === null) return { outputs: [], unmodeled: "file -C without -m: it compiles the default magic path (MAGIC or the build's own), a destination the gate does not know" };
	if (unknown(m) || m.expanded) return { outputs: [], unmodeled: `file -C with a magic path not typed out as literal text (\`${m.text}\`)` };
	if (!e.dirKnown) return { outputs: [], unmodeled: "file -C after a cd to a directory the gate does not know: it writes its .mgc output there" };
	const outputs: Word[] = [];
	for (const part of m.text.split(":")) {
		if (part === "") break;
		const base = part.slice(part.lastIndexOf("/") + 1);
		const stem = base.endsWith(".mgc") ? base.slice(0, -4) : base;
		outputs.push({ text: `${stem}.mgc`, opaque: false });
		if (mime) outputs.push({ text: `${stem}.mime.mgc`, opaque: false });
	}
	return { outputs, unmodeled: null };
}

/**
 * An output option a read-only head does not document (`--output`, `--out…`, `--compile`): refused
 * rather than guessed at (Plumb's fix-6 call for read-only git, `--output` stays refused outright,
 * applied to every read-only head in fix round 7).
 */
const UNDOCUMENTED_OUTPUT = /^--(?:o|ou|out[\w-]*|comp\w*|write[\w-]*)(?:=|$)/;

/**
 * Why a read-only head's options are not a form the gate models, or null (astra-7 B5): `file`'s
 * options per its own table, and an undocumented output option on any other head. xxd's options are
 * read by xxdOperands (every operand counts as written when one is not xxd's).
 */
export function readHeadUnmodeled(e: Exec): string | null {
	const name = basename(e.argv[0]!.text);
	if (!READ_ONLY_HEADS[name]) return null;
	if (name === "file") return fileOutputs(e).unmodeled;
	for (const w of e.argv.slice(1)) {
		if (w.text === "--") break;
		if (UNDOCUMENTED_OUTPUT.test(w.text)) return `${name} ${w.text.split("=")[0]}, an output option ${name} does not document`;
	}
	return null;
}

/**
 * Search and filter commands the orchestrator reads with (P-11 row 15; M7 fix round 2: Ilex's
 * `git -C <repo> ls-files | grep -i read` was refused because `grep` sat in no read table). Kept
 * apart from READ_ONLY_HEADS on purpose: rows 6 and 10 read that table as "may name the ledger with
 * no further check", and some of these run programs or write files through their options, so they
 * are read-typed for row 15 only, through searchHeadUnmodeled. Their write and run forms, from each
 * one's documentation on the pinned machine (macOS man pages; `rg --help`, ripgrep 15.0.0; awk
 * version 20200816): find `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir` (and GNU find's `-fprint`,
 * `-fprint0`, `-fprintf`, `-fls`); sort `-o`/`--output` (writeDestinations) and
 * `--compress-program=PROGRAM`; uniq's second operand, `output_file` (writeDestinations); rg
 * `--pre=COMMAND` and `--hostname-bin=COMMAND` run a program, `-z`/`--search-zip` runs
 * decompressors, and the file RIPGREP_CONFIG_PATH names can add any of them (`--no-config` skips it);
 * awk's program writes with `print > file`, pipes with `|` and runs with `system(cmd)`. grep, egrep,
 * fgrep and cut document none.
 */
export const SEARCH_HEADS: Record<string, true> = { grep: true, egrep: true, fgrep: true, cut: true, rg: true, find: true, sort: true, uniq: true, awk: true };

/** Heads whose options neither write nor run anything: a word the gate cannot read is only a pattern or a file. */
const PLAIN_SEARCH: Record<string, true> = { grep: true, egrep: true, fgrep: true, cut: true };
const FIND_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const RG_RUNS = /^--(?:pre|hostname-bin|search-zip)(?:=|$)/;
/** rg short options that take a value (`rg --help`, ripgrep 15.0.0): the rest of the word, else the next word. */
const RG_SHORT_VALUE: Record<string, true> = Object.fromEntries([..."efEmjgdtTABCMr"].map((c) => [c, true]));
/** awk's program text: an output redirection or pipe (`>`, `|`), `system(…)`, or gawk's `@load`/`@include`. `$3 > 5` is refused too: loud over silent. */
const AWK_WRITES = /[>|@]|\bsystem\s*\(/;

/**
 * Why a SEARCH_HEADS command is not a form row 15 models as a read, or null. The destinations
 * sort and uniq write are listed by writeDestinations, which row 15 reads first.
 */
export function searchHeadUnmodeled(e: Exec, env: Record<string, string | undefined>): string | null {
	const name = basename(e.argv[0]!.text);
	if (!SEARCH_HEADS[name]) return null;
	const args = e.argv.slice(1);
	for (const w of args) {
		if (w.text === "--") break;
		if (UNDOCUMENTED_OUTPUT.test(w.text)) return `${name} ${w.text.split("=")[0]}, an output option ${name} does not document`;
	}
	if (PLAIN_SEARCH[name]) return null;
	const opaque = args.find((w) => unknown(w) || w.expanded);
	if (opaque) return `${name} with a word not typed out as literal text (\`${opaque.text}\`), which may be an option that writes or runs something`;
	if (name === "find") {
		const act = args.find((w) => FIND_ACTIONS.test(w.text));
		return act ? `find ${act.text}, which deletes files, writes a file or runs a command` : null;
	}
	if (name === "sort") {
		const run = args.find((w) => /^--compress-program(?:=|$)/.test(w.text));
		return run ? "sort --compress-program, which runs a program" : null;
	}
	if (name === "rg") {
		if (env.RIPGREP_CONFIG_PATH && !args.some((w) => w.text === "--no-config")) return "rg with RIPGREP_CONFIG_PATH set: its config file can add --pre, which runs a program (pass --no-config)";
		for (let i = 0; i < args.length; i++) {
			const t = args[i]!.text;
			if (t === "--") break;
			if (RG_RUNS.test(t)) return `rg ${t.split("=")[0]}, which runs a program`;
			if (!/^-[^-]/.test(t)) continue;
			for (let k = 1; k < t.length; k++) {
				if (t[k] === "z") return "rg -z, which runs decompression programs";
				if (RG_SHORT_VALUE[t[k]!]) {
					if (k === t.length - 1) i++;
					break;
				}
			}
		}
		return null;
	}
	if (name === "awk") {
		let i = 0;
		for (; i < args.length; i++) {
			const t = args[i]!.text;
			if (t === "--") {
				i++;
				break;
			}
			if (!t.startsWith("-") || t === "-") break;
			if (t === "-F" || t === "-v") i++;
			else if (!t.startsWith("-F") && !t.startsWith("-v")) return `awk ${t}, an option the gate does not model (-f reads the program from a file; gawk's -i, -l and -E load code)`;
		}
		const program = args[i];
		if (!program) return "awk with no program text";
		return AWK_WRITES.test(program.text) ? "awk whose program has `>`, `|`, `@` or `system(`: it can write a file or run a command" : null;
	}
	return null;
}

/**
 * The ctx history CLI's read forms (DESIGN-2.0.md § C7.5: older history is one ctx index query away;
 * M8 ctx wiring, 2026-09-30), read-typed for row 15 only, like SEARCH_HEADS. Row 6 already passes
 * every ctx form (none is a § A4 reserved action), so its table is unchanged. From ctx 2.1.3's own
 * `--help` and `ctx docs show storage` on the pinned machine: `search`, `show`, `locate`, `blame`,
 * `status`, `sources`, `doctor` and `graph search` (alias `graph query`) read the index; "Status,
 * doctor, and index wait/watch only observe existing state". Their write forms: `search
 * --refresh wait` runs the refresh (an import) before searching; `status --usage
 * enable|disable|reset` changes the usage store; `sources add`/`remove` edit config.toml;
 * `show session --out` writes a file (UNDOCUMENTED_OUTPUT); `graph --query-log` appends to one.
 * Every other subcommand (`import`, `setup`, `index`, `integrations`, `semantic`, `upgrade`,
 * `daemon`, graph's writers, ...) is not a read. A word not typed out as literal text before `--`
 * may be any of those options, so it is refused.
 */
const CTX_READS: Record<string, true> = { search: true, show: true, locate: true, blame: true, status: true, sources: true, doctor: true, "graph search": true, "graph query": true };
/** ctx's global options (`ctx --help`): true takes a value. */
const CTX_GLOBAL: Record<string, boolean> = { "--data-root": true, "--color": true, "--quiet": false, "--help": false, "-h": false, "--version": false, "-V": false };
/** `ctx graph`'s own options before its subcommand (`ctx graph --help`): true takes a value. --query-log is refused below. */
const CTX_GRAPH_GLOBAL: Record<string, boolean> = { "--db": true, "--json": false, "--log-responses": false, "--query-log": true };

/** Skip `table`'s options from `i`; the index of the first word that is not one, or a refusal. */
function ctxOptions(words: Word[], i: number, table: Record<string, boolean>, what: string): number | string {
	for (; i < words.length; i++) {
		const w = words[i]!;
		if (unknown(w) || w.expanded) return `${what} with a word not typed out as literal text (\`${w.text}\`), which may be an option that writes`;
		const eq = w.text.indexOf("=");
		const name = w.text.startsWith("--") && eq > 0 ? w.text.slice(0, eq) : w.text;
		if (!(name in table)) return i;
		if (table[name] && eq < 0) i++;
	}
	return i;
}

/** Why a `ctx` command is not one of its read forms, or null (see CTX_READS). */
export function ctxUnmodeled(e: Exec): string | null {
	const words = e.argv.slice(1);
	let i = ctxOptions(words, 0, CTX_GLOBAL, "ctx");
	if (typeof i === "string") return i;
	if (i >= words.length) return null; // `ctx` alone, or only global options: help or version
	let verb = words[i]!.text;
	if (verb === "graph") {
		const start = i + 1;
		i = ctxOptions(words, start, CTX_GRAPH_GLOBAL, "ctx graph");
		if (typeof i === "string") return i;
		if (words.slice(start, i).some((w) => w.text.startsWith("--query-log"))) return "ctx graph --query-log, which appends to a file";
		const sub = words[i];
		if (!sub) return null;
		if (unknown(sub) || sub.expanded) return `ctx graph with a subcommand not typed out as literal text (\`${sub.text}\`)`;
		verb = `graph ${sub.text}`;
	}
	if (!CTX_READS[verb]) return `ctx ${verb}, a ctx command that is not one of its reads (search, show, locate, blame, status, sources, doctor, graph search)`;
	const rest = words.slice(i + 1);
	for (let k = 0; k < rest.length; k++) {
		const w = rest[k]!;
		const t = w.text;
		if (t === "--") break;
		if (unknown(w) || w.expanded) return `ctx ${verb} with a word not typed out as literal text (\`${t}\`), which may be an option that writes`;
		if (UNDOCUMENTED_OUTPUT.test(t)) return `ctx ${verb} ${t.split("=")[0]}, which writes a file`;
		if (/^--query-log(?:=|$)/.test(t)) return `ctx ${verb} --query-log, which appends to a file`;
		if (verb === "status" && /^--usage(?:=|$)/.test(t)) return "ctx status --usage, which enables, disables or resets the local usage store";
		if (verb === "sources" && (t === "add" || t === "remove")) return `ctx sources ${t}, which edits ctx's config`;
		if (verb === "search" && /^--refresh(?:=|$)/.test(t)) {
			const value = t.includes("=") ? t.slice(t.indexOf("=") + 1) : rest[k + 1]?.text;
			if (value !== "off" && value !== "background") return `ctx search --refresh ${value ?? ""}, which runs the index refresh (an import) before searching; --refresh off or background reads`;
		}
	}
	return null;
}

/**
 * The value of an option word at `argv[i]` whose value may be attached (`sort -oF`, `cp -tDIR`),
 * `lead` its text up to and including the option letter: the rest of the word, cut with dropLead,
 * or the next word when nothing is attached. When the known text ends at the option letter but the
 * word carries candidates or fragments (`-o"$p"`, item 102), the value may be in the word's unknown
 * part or be the next word: both are returned.
 */
function attachedValue(argv: Word[], i: number, lead: string): Word[] {
	const w = argv[i]!;
	const next = argv[i + 1];
	if (w.text !== lead) return [dropLead(w, lead)];
	const attached = w.candidates || w.fragments ? [dropLead(w, lead)] : [];
	return next ? [...attached, next] : attached;
}

/**
 * Where a command writes files: redirect targets, `tee` operands, the destination of
 * cp/mv/ln/install/rsync, `dd of=`, `sort -o`, uniq's second operand, xxd's second operand (every operand when its words
 * are not ones xxd documents), and `file -C`'s compiled `.mgc` files (fileOutputs). Rows 6 (a write
 * inside .git) and 10 (a write to the ledger) both read this, before any read-only allowance (M4 fix
 * round 6, astra-6 B6; round 7, astra-7 B5). A destination cut from an option word (`of=`,
 * `--output=`, `-oF`, `-tDIR`, `--target-directory=`) is cut with dropLead, so its candidates and
 * fragments are cut too; a `-t`/`--target-directory` directory is judged as written (item 102).
 */
export function writeDestinations(e: Exec): Word[] {
	const out = e.redirects.flatMap((r) => (r.op.includes(">") && r.op !== ">&" && r.target ? [r.target] : []));
	const name = basename(e.argv[0]!.text);
	const operands = e.argv.slice(1).filter((w) => !w.text.startsWith("-"));
	if (name === "tee") out.push(...operands);
	if (name === "cp" || name === "mv" || name === "ln" || name === "install" || name === "rsync") {
		// rsync's `-t` is `--times`; rsync keeps the bare-`-t` reading it always had, and no attached value.
		const rsync = name === "rsync";
		const t = e.argv.findIndex((w) => w.text === "-t" || (!rsync && w.text.startsWith("-t")) || w.text.startsWith("--target-directory"));
		const w = e.argv[t];
		if (t <= 0 || !w) {
			const dest = operands.at(-1);
			if (dest) out.push(dest);
		} else if (w.text.startsWith("--target-directory") && w.text.includes("=")) out.push(dropLead(w, w.text.slice(0, w.text.indexOf("=") + 1)));
		else if (w.text.startsWith("--target-directory") || rsync) {
			if (e.argv[t + 1]) out.push(e.argv[t + 1]!);
		} else out.push(...attachedValue(e.argv, t, "-t"));
	}
	if (name === "dd") for (const w of e.argv) if (w.text.startsWith("of=")) out.push(dropLead(w, "of="));
	if (name === "sort") {
		for (let i = 1; i < e.argv.length; i++) {
			const w = e.argv[i]!;
			if (w.text === "--output") {
				if (e.argv[i + 1]) out.push(e.argv[i + 1]!);
			} else if (w.text.startsWith("--output=")) out.push(dropLead(w, "--output="));
			else if (/^-[^-]*o/.test(w.text)) {
				// `-o F`, `-oF`, `-uo F`: the rest of the word after `o`, else the next word.
				out.push(...attachedValue(e.argv, i, w.text.slice(0, w.text.indexOf("o") + 1)));
			}
		}
	}
	if (name === "uniq") {
		// `uniq [-cdiu] [-D[septype]] [-f num] [-s chars] [input_file [output_file]]` (macOS uniq(1);
		// GNU adds -w and the long forms): the second operand is the file uniq writes.
		const ops: Word[] = [];
		for (let i = 1; i < e.argv.length; i++) {
			const t = e.argv[i]!.text;
			if (t === "--") {
				ops.push(...e.argv.slice(i + 1));
				break;
			}
			if (/^-[fsw]$/.test(t) || /^--(?:skip-fields|skip-chars|check-chars)$/.test(t)) i++;
			else if (!t.startsWith("-") || t === "-") ops.push(e.argv[i]!);
		}
		if (ops[1]) out.push(ops[1]);
	}
	if (name === "xxd") {
		const ops = xxdOperands(e.argv);
		if (ops === null) out.push(...operands);
		else if (ops[1]) out.push(ops[1]);
	}
	if (name === "file") out.push(...fileOutputs(e).outputs);
	return out;
}

/** `git` global options that take a value word. */
const GIT_VALUE_OPTS: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--exec-path": true, "--config-env": true, "--super-prefix": true };

export interface GitCall {
	/** Directory git runs in after its `-C` hops (gitDir); "" when a hop is unknown or does not resolve. */
	dir: string;
	/**
	 * The same directory resolved lexically (lexicalDir), for hops whose components do not exist yet;
	 * "" when the start directory or a hop is unknown or a hop has a `..`. Read only by the row 6 scratch
	 * rules (PLAN wl-mv5oikd5jtquww § 1.2 rule 6); everywhere else the directory stays `dir`.
	 */
	dirLexical: string;
	/** The subcommand, or null when it is opaque or a glob. */
	sub: string | null;
	/** Words after the subcommand. */
	args: Word[];
	/** The global options before the subcommand. */
	globals: Word[];
}

/** `p` resolved from `base` (already physical) one component at a time; null when a component does not exist. */
function physical(base: string, p: string): string | null {
	let cur = p.startsWith("/") ? "/" : base;
	for (const part of p.split("/")) {
		if (part === "" || part === ".") continue;
		// `cur` is already free of symlinks, so its parent is what `..` reaches, as chdir(2) does.
		// (Bun's realpathSync.native collapses a `..` in its input before resolving the symlink in
		// front of it, so the path is never handed over whole: measured on Bun 1.3.14, M4 fix round 4.)
		// chdir(2) walks through every component, so each one before a `..` must be a directory:
		// `-C file/..` fails in git (ENOTDIR), and so does it here (astra-5 S4).
		if (part === "..") {
			try {
				if (!statSync(cur).isDirectory()) return null;
			} catch {
				return null;
			}
			cur = dirname(cur);
			continue;
		}
		try {
			cur = realpathSync.native(cur === "/" ? `/${part}` : `${cur}/${part}`);
		} catch {
			return null;
		}
	}
	try {
		return statSync(cur).isDirectory() ? cur : null;
	} catch {
		return null;
	}
}

/**
 * The directory git runs in from `start` after the `-C` paths `hops`, the way git takes them (M4 fix
 * round 4, S1; git(1) `-C`: "each subsequent non-absolute -C <path> is interpreted relative to the
 * preceding -C <path>. If <path> is present but empty, e.g. -C "", then the current working
 * directory is left unchanged"). git changes into each directory in turn, so a hop's `..` leaves the
 * directory a symlink reached, not the one the text names: each hop is canonicalized before the
 * next applies (`-C /var -C ..` is `/private` on macOS). Null when a hop does not resolve to an
 * existing directory: git would stop there, and the gate does not guess past it. With no non-empty
 * hop, the start directory as given, canonical when it exists. One resolver for the danger
 * analysis and the directory a push runs in (gitCall, gitUnmodeled).
 */
export function gitDir(start: string, hops: string[]): string | null {
	let cur = physical("/", resolve(start));
	for (const hop of hops) {
		if (hop === "") continue;
		if (cur === null && !hop.startsWith("/")) return null;
		cur = physical(cur ?? "/", hop);
		if (cur === null) return null;
	}
	return cur ?? resolve(start);
}

/**
 * `start` after the `-C` paths `hops`, lexically: nothing is read, so a hop that does not exist yet
 * (made earlier in the same call) still has a directory. "" when a hop holds a `..` component, which
 * chdir(2) would take from wherever a symlink before it led. Only the scratch rules use it; they then
 * check the result is inside the own root physically, and the call runs confined (fence.ts).
 */
export function lexicalDir(start: string, hops: string[]): string {
	let cur = resolve(start);
	for (const hop of hops) {
		if (hop === "") continue;
		if (hop.split("/").includes("..")) return "";
		cur = resolve(cur, hop);
	}
	return cur;
}

/** A `git` Exec, split into its directory, subcommand and arguments. */
export function gitCall(e: Exec): GitCall | null {
	if (unknown(e.argv[0]) || basename(e.argv[0]!.text) !== "git") return null;
	const hops: string[] = [];
	let unknownHop = false;
	let i = 1;
	while (i < e.argv.length) {
		const w = e.argv[i]!;
		if (unknown(w) || !w.text.startsWith("-")) break;
		if (w.text === "-C") {
			const d = e.argv[i + 1];
			if (d && unknown(d)) unknownHop = true;
			else if (d) hops.push(d.text);
		}
		i += GIT_VALUE_OPTS[w.text] ? 2 : 1;
	}
	const dir = unknownHop ? "" : (gitDir(e.dir, hops) ?? "");
	const dirLexical = unknownHop || !e.dirKnown ? "" : lexicalDir(e.dir, hops);
	const sub = e.argv[i];
	const globals = e.argv.slice(1, i);
	if (!sub) return { dir, dirLexical, sub: "", args: [], globals };
	return { dir, dirLexical, sub: unknown(sub) ? null : sub.text, args: e.argv.slice(i + 1), globals };
}

// The closed sets below are what `gitUnmodeled` lets through. Each was chosen by hand from
// git-config(1), git(1) and git's environment variables at git 2.50.1 (Apple Git-155), M4 fix
// rounds 3-4: a member is in only because it neither runs a program, reads another config file,
// nor moves the repository. Refresh: read the current git(1) OPTIONS and ENVIRONMENT VARIABLES
// sections and git-config(1) for each member; add a member only with that reading recorded.
/** `-c` keys the gate models. `alias.*` is not one (M4 fix round 4, B1: an alias runs what it names). */
const MODELED_GIT_CONFIG = /^(?:user\.(?:name|email)|color\.[\w.-]+|advice\.[\w-]+|core\.quotepath|init\.defaultbranch|(?:commit|tag)\.gpgsign|gc\.auto)$/i;

/** Global options that neither select a repository nor read other configuration. */
const MODELED_GIT_FLAG = /^(?:--no-pager|-P|-p|--paginate|--no-replace-objects|--no-lazy-fetch|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--version|-v|--help|-h|--html-path|--man-path|--info-path)$/;
/** Environment a command may set for git: identity, prompts, tracing. Everything else `GIT_*`, and PATH/HOME/XDG_CONFIG_HOME, is an override. */
const MODELED_GIT_ENV = /^(?:GIT_TERMINAL_PROMPT|GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|GIT_OPTIONAL_LOCKS|GIT_FLUSH|GIT_MERGE_AUTOEDIT|GIT_ADVICE|GIT_PROGRESS_DELAY)$/;
/**
 * git's trace variables, each named in git(1) on git 2.50.1 (`man git`: GIT_TRACE, GIT_TRACE2,
 * GIT_TRACE2_EVENT, GIT_TRACE2_PERF, GIT_TRACE_CURL, GIT_TRACE_CURL_NO_DATA, GIT_TRACE_FSMONITOR,
 * GIT_TRACE_PACKET, GIT_TRACE_PACKFILE, GIT_TRACE_PACK_ACCESS, GIT_TRACE_PERFORMANCE,
 * GIT_TRACE_REDACT, GIT_TRACE_REFS, GIT_TRACE_SETUP, GIT_TRACE_SHALLOW). Any other `GIT_TRACE…` name
 * is an unmodeled GIT_* variable (M4 fix round 6, astra-6 B7: `GIT_TRACE\w*` admitted names git may
 * add later).
 */
const GIT_TRACE_ENV = /^GIT_TRACE(?:|2|2_EVENT|2_PERF|_CURL|_CURL_NO_DATA|_FSMONITOR|_PACKET|_PACKFILE|_PACK_ACCESS|_PERFORMANCE|_REDACT|_REFS|_SETUP|_SHALLOW)$/;
/**
 * A trace value that names no file. git(1), GIT_TRACE: "1", "2" or "true" (case insensitive) print to
 * stderr; an integer from 3 to 9 is an open file descriptor; "if the variable is set to an absolute
 * path … the trace messages will be written to this file"; empty, "0" or "false" disable it.
 */
const TRACE_NO_FILE = /^(?:|0|1|2|[3-9]|true|false)$/i;

/** Every assignment occurrence in `assigned`, as `[name, word]`, in order per name (astra-8 B1). */
export function* occurrences(assigned: Map<string, Word[]>): Generator<[string, Word]> {
	for (const [name, ws] of assigned) for (const w of ws) yield [name, w];
}

/**
 * The files git's trace variables write, for a git command: each assignment (prefix, `env NAME=v`,
 * or exported earlier in the string) of a GIT_TRACE_ENV name whose value is not TRACE_NO_FILE, the
 * word's text cut to the value. Row 6 refuses one that is not a literal absolute path or is inside
 * .git (gitUnmodeled); row 10 one that names the ledger (astra-6 B7:
 * `GIT_TRACE=<ledger> git status` appends to the ledger).
 */
export function gitTraceFiles(assigned: Map<string, Word[]>): Word[] {
	const out: Word[] = [];
	for (const [name, w] of occurrences(assigned)) {
		if (!GIT_TRACE_ENV.test(name)) continue;
		const value = w.text.slice(name.length + 1);
		if (!w.opaque && TRACE_NO_FILE.test(value)) continue;
		out.push({ ...w, text: value });
	}
	return out;
}

/** Pager/editor variables git runs as a command: modeled only with a value that runs nothing. */
const GIT_COMMAND_ENV = /^(?:GIT_PAGER|PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL)$/;
const INERT_COMMAND = /^(?:cat|true|:|less|)$/;
/** `env` flags that clear, unset or change directory: git would then read a different repository or config. */
const ENV_UNMODELED_FLAG = /^(?:-[A-Za-z]*[iuCP]|--(?:ignore-environment|unset|chdir|block-signal|default-signal|ignore-signal)\b)/;

/**
 * Why a `git` Exec is a form the gate does not model, or null (M4 fix round 3, Jo 2026-09-29:
 * "go ahead with the invert"). Modeled: every word literal; global options only from
 * MODELED_GIT_FLAG, `-c` with a MODELED_GIT_CONFIG key, and `-C` with a literal path that resolves
 * to an existing directory (Jo 2026-09-29, "carve it out"; gitDir), but never `-C` together with
 * `-c`; a subcommand from GIT_BUILTINS (anything else may be an alias or a `git-*` program: fix
 * round 4, B1); no command-local or exported `GIT_*`/PATH/HOME/XDG_CONFIG_HOME outside
 * MODELED_GIT_ENV; no `env` that clears, unsets or moves, and no `sudo`/`doas` (another HOME).
 * Anything else — `-c alias.*`, `--git-dir`, `--work-tree`, `--config-env`, `--exec-path`,
 * `GIT_CONFIG_*`, `GIT_DIR` — is refused (R3-B1, R3-B6, R4-B1).
 *
 * Arguments follow command names (fix round 4, S4, Plumb's ruling): a word spelled through an
 * expansion (`$X`, `$'…'`, braces, a substitution) is refused as a command name, so it is refused
 * as a git argument too, even when the gate knows the value. `git checkout $'master'` is refused;
 * `git checkout master` is the spelling.
 *
 * `scratch` (row 6's scratch rules, PLAN wl-mv5oikd5jtquww § 1.2 rule 6, only for a lane or hand with
 * its own scratch root): an expanded `-C` path or argument is modeled too when it is a
 * `"$AS2_SCRATCH/…"` spelling whose expansion is inside the root, and a `-C` path that does not exist
 * yet when its lexical directory is inside the root. Nothing else changes.
 */
export function gitUnmodeled(e: Exec, assigned: Map<string, Word[]>, scratch?: ScratchWords): string | null {
	if (!gitCall(e)) return null;
	for (const w of e.mods.wrappers) {
		const [name, ...flags] = w.split(" ");
		if (name === "sudo" || name === "doas") return `git run through ${name}, which gives it another user's HOME and config`;
		if (name === "env" && flags.some((f) => ENV_UNMODELED_FLAG.test(f))) return `git under \`${w}\`, which changes its environment or directory`;
	}
	for (const [name, w] of occurrences(assigned)) {
		const value = w.text.slice(name.length + 1);
		if (GIT_COMMAND_ENV.test(name)) {
			if (w.opaque || !INERT_COMMAND.test(value)) return `git with ${name} set to a command (${w.text})`;
		} else if (GIT_TRACE_ENV.test(name)) {
			if (w.opaque) return `git with ${name} set to a value not typed out as literal text (${w.text}), a file git would write`;
			if (TRACE_NO_FILE.test(value)) continue;
			if (!value.startsWith("/")) return `git with ${name}=${value}, a trace target the gate does not model (only off, 1, 2, true, a descriptor 3-9, or an absolute file path)`;
			if (insideDotGit(resolve(e.dir, value))) return `git with ${name} writing its trace into ${value}, inside .git (git's own hooks, config and refs)`;
		} else if ((/^GIT_/.test(name) && !MODELED_GIT_ENV.test(name)) || /^(?:PATH|HOME|XDG_CONFIG_HOME)$/.test(name)) {
			return `git with ${name} set in the same command (${w.text})`;
		}
	}
	let config = false;
	const hops: string[] = [];
	let i = 1;
	for (; i < e.argv.length; i++) {
		const w = e.argv[i]!;
		if (unknown(w) || w.expanded) return `git with a word not typed out as literal text (\`${w.text}\`)`;
		const t = w.text;
		if (!t.startsWith("-")) break;
		if (t === "-C") {
			const p = e.argv[++i];
			if (!p || unknown(p) || (p.expanded && !scratch?.word(p))) return "git -C with a path that is not literal text";
			hops.push(p.text);
		} else if (t === "-c") {
			const kv = e.argv[++i];
			if (!kv || unknown(kv) || kv.expanded) return "git -c with a value not typed out as literal text";
			const key = kv.text.includes("=") ? kv.text.slice(0, kv.text.indexOf("=")) : kv.text;
			if (!MODELED_GIT_CONFIG.test(key)) return `git -c ${key}, a config override the gate does not model`;
			config = true;
		} else if (!MODELED_GIT_FLAG.test(t)) return `git ${t}, an option the gate does not model`;
	}
	if (hops.length > 0 && config) return "git -C together with -c";
	if (gitDir(e.dir, hops) === null && !(scratch && e.dirKnown && scratch.dir(lexicalDir(e.dir, hops)))) {
		return `git -C ${hops.map((h) => JSON.stringify(h)).join(" -C ")}, which does not resolve to an existing directory`;
	}
	const sub = e.argv[i];
	if (sub && !unknown(sub) && !sub.expanded && !GIT_BUILTINS.has(sub.text)) {
		return `git ${sub.text}, which is not one of git's own commands (it may be a configured alias or a git-${sub.text} program the gate does not read)`;
	}
	if (e.argv.slice(i).some((w) => unknown(w) || (w.expanded && !scratch?.word(w)))) return "git with an argument not typed out as literal text (a variable, `$'…'`, braces, a substitution or a glob)";
	return null;
}

/**
 * Row 6's scratch-root hooks into gitUnmodeled (PLAN wl-mv5oikd5jtquww § 1.2 rule 6; r06-reserved.ts
 * builds them): `word` accepts an expanded word spelled `"$AS2_SCRATCH/…"` whose expansion is inside
 * the own root, `dir` a lexical directory inside it. Each records what it accepted, so the call is
 * marked confined.
 */
export interface ScratchWords {
	word(w: Word): boolean;
	dir(path: string): boolean;
}

// Interpreter and loader environment (M4 fix round 7, astra-7 B3). A variable an interpreter or the
// dynamic loader reads can make a command write a file (`NODE_OPTIONS=--redirect-warnings=<f>`) or
// run code the gate never reads (`--require`, `--import=data:…`, PERL5OPT=-M, LD_PRELOAD), whichever
// command follows. The whole string's assignments (prefix, bare, exported, `env NAME=v`) are judged,
// because the bash tool's shell persists: an export reaches the next call's interpreter too.

/** The families judged: anything an interpreter, the shell or the loader reads as options, a preload or a module path. */
const INTERPRETER_ENV = /^(?:NODE_\w+|BUN_\w+|PYTHON\w+|PERL\w*|RUBY\w+|LD_\w+|DYLD_\w+|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PHPRC|PHP_INI_SCAN_DIR|GCONV_PATH)$/;
/** Members that neither load code, move module resolution nor name a file: any value is modeled. */
const INERT_INTERPRETER_ENV =
	/^(?:NODE_ENV|NODE_NO_WARNINGS|NODE_DISABLE_COLORS|NODE_PENDING_DEPRECATION|NODE_DEBUG|BUN_DEBUG_QUIET_LOGS|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PYTHONIOENCODING|PYTHONHASHSEED|PYTHONUTF8|PYTHONNOUSERSITE|PYTHONSAFEPATH|PYTHONFAULTHANDLER|PYTHONDEVMODE)$/;
/** Members whose value is a program (or library) the interpreter, shell or loader runs first. */
const PRELOAD_ENV = /^(?:PYTHONSTARTUP|LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES|BASH_ENV|ENV|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PERL5DB|NODE_REPL_EXTERNAL_MODULE)$/;
/** Members that move where an interpreter or the loader finds its modules, so a name may resolve to a program the gate does not read. */
const MODULE_PATH_ENV = /^(?:NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|PYTHONPLATLIBDIR|PERL5LIB|PERLLIB|RUBYLIB|LD_\w*PATH|DYLD_\w*PATH|GCONV_PATH|PHPRC|PHP_INI_SCAN_DIR)$/;
/**
 * Of those, the interpreter module paths modeled when every entry is literal and inside the working
 * repository (Main's ruling, fix round 7, under SPEC § A4's accidental-misuse threat model:
 * `PYTHONPATH=. python3 -m pytest` allowed): the repo's own code is code a lane is working on anyway.
 */
const REPO_MODULE_PATH_ENV = /^(?:NODE_PATH|PYTHONPATH|PERL5LIB|PERLLIB|RUBYLIB)$/;

/** `p` with symlinks resolved through its deepest existing ancestor (the rest joined on lexically). */
export function physicalPath(p: string): string {
	let head = p;
	const rest: string[] = [];
	while (!existsSync(head)) {
		const up = dirname(head);
		if (up === head) return p;
		rest.unshift(basename(head));
		head = up;
	}
	return resolve(realpathSync(head), ...rest);
}

/** The working tree root containing `dir` (the nearest ancestor holding `.git`), physical; null outside one. */
function repoRoot(dir: string): string | null {
	for (let p = physicalPath(dir); ; p = dirname(p)) {
		if (existsSync(resolve(p, ".git"))) return p;
		if (dirname(p) === p) return null;
	}
}

/**
 * Why a module path is not every-entry-inside-the-repository, or null. Entries split at `:`; an empty
 * one is the working directory. Every entry is judged from every directory the command string runs in
 * (`dirs`), against that directory's own repository; null `dirs` (a cd the gate cannot follow) leaves
 * the repository unknown, so the path is unmodeled.
 */
function moduleOutsideRepo(name: string, value: string, dirs: string[] | null): string | null {
	if (dirs === null) return `${name}=${value} after a cd to a directory the gate does not know, so its repository is unknown`;
	for (const dir of dirs) {
		const home = repoRoot(dir);
		if (home === null) return `${name}=${value} run outside a git working tree, so its modules may be code the gate does not read`;
		for (const entry of value.split(":")) {
			// `..` after a symlink climbs from the link's target, as the OS reads it: resolve physically
			// one component at a time; a path that does not exist yet adds no modules, unless it climbs.
			const e = entry === "" ? "." : entry;
			const walked = physical(physicalPath(dir), e);
			if (walked === null && e.split("/").includes("..")) return `${name} entry \`${entry}\` climbs with \`..\` through a path that does not exist, which the gate cannot place`;
			const p = walked ?? physicalPath(resolve(dir, e));
			if (repoRoot(p) !== home) return `${name} entry \`${entry}\` resolves outside the repository (${home}), so a name may load code the gate does not read`;
			if (insideDotGit(p)) return `${name} entry \`${entry}\` inside .git`;
		}
	}
	return null;
}

/**
 * The directories an assignment reaches: a prefix or `env NAME=v` assignment only the commands it
 * prefixes; a bare or exported one every command in the string, and `cwd` (the shell persists). Null
 * when one of them is a cd the gate cannot follow.
 */
function assignmentDirs(x: Pick<Expansion, "commands">, w: Word, cwd: string): string[] | null {
	const owners = x.commands.filter((e) => e.mods.assigns.includes(w));
	const reached = owners.length > 0 ? owners : x.commands;
	if (reached.some((e) => !e.dirKnown)) return null;
	return [...new Set([...(owners.length > 0 ? [] : [cwd]), ...reached.map((e) => e.dir)])];
}

/**
 * Node's options that change nothing but reporting and limits (node --help, v24), as NODE_OPTIONS
 * accepts them. Node normalizes `_` to `-` in option names and matches no prefixes (tested live:
 * `--redirect_warnings` works, `--req=` is "not allowed in NODE_OPTIONS").
 */
const NODE_INERT_OPTION =
	/^--(?:no-warnings|no-deprecation|trace-warnings|trace-deprecation|throw-deprecation|pending-deprecation|trace-uncaught|enable-source-maps|use-openssl-ca|use-bundled-ca|use-system-ca|(?:max-old-space-size|max-semi-space-size|stack-trace-limit|max-http-header-size)=\d+|unhandled-rejections=(?:strict|warn|none|throw|warn-with-error-code)|dns-result-order=(?:ipv4first|ipv6first|verbatim))$/;
/** Node options that load code before the program (`-r`, `--require`, `--import`, `--loader`, `--experimental-loader`). */
const NODE_PRELOAD_OPTION = /^(?:-r|--require|--import|--loader|--experimental-loader)$/;
/** bun's options (bun --help) that change nothing but memory, output and install behaviour. */
const BUN_INERT_OPTION = /^(?:--smol|--silent|--bun|-b|--no-install|--prefer-offline|--no-deprecation|--no-env-file)$/;
/** bun's preload spellings (bun --help: `-r, --preload`, `--require` and `--import` its aliases). */
const BUN_PRELOAD_OPTION = /^(?:-r|--preload|--require|--import)$/;

/**
 * NODE_OPTIONS / BUN_OPTIONS split into arguments as Node splits it: at spaces, with `"…"` grouping
 * and `\` escaping inside quotes; null on an unclosed quote (node refuses to start).
 */
function splitOptionsEnv(s: string): string[] | null {
	const out: string[] = [];
	let cur = "";
	let started = false;
	let quoted = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quoted) {
			if (c === "\\" && i + 1 < s.length) cur += s[++i];
			else if (c === '"') quoted = false;
			else cur += c;
		} else if (c === '"') {
			quoted = true;
			started = true;
		} else if (/\s/.test(c)) {
			if (started) out.push(cur);
			cur = "";
			started = false;
		} else {
			cur += c;
			started = true;
		}
	}
	if (quoted) return null;
	if (started) out.push(cur);
	return out;
}

/** A path an option or variable names for writing: a literal absolute path, or why it is not modeled. */
function envPath(what: string, value: string | undefined, w: Word, writes: Word[]): string | null {
	if (value === undefined || value === "") return `${what} with no file after it`;
	if (!value.startsWith("/")) return `${what}=${value}, a file the gate does not model (only a literal absolute path)`;
	writes.push({ ...w, text: value });
	return null;
}

/** Why one NODE_OPTIONS or BUN_OPTIONS value is not modeled, collecting the files it writes. */
function optionsEnvUnmodeled(name: string, value: string, w: Word, writes: Word[]): string | null {
	const args = splitOptionsEnv(value);
	if (args === null) return `${name} with an unclosed quote`;
	const node = name === "NODE_OPTIONS";
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const eq = a.indexOf("=");
		let opt = eq < 0 ? a : a.slice(0, eq);
		if (node && opt.startsWith("--")) opt = `--${opt.slice(2).replace(/_/g, "-")}`;
		const normalized = eq < 0 ? opt : `${opt}${a.slice(eq)}`;
		if (node ? NODE_INERT_OPTION.test(normalized) : BUN_INERT_OPTION.test(normalized)) continue;
		if (node ? NODE_PRELOAD_OPTION.test(opt) : BUN_PRELOAD_OPTION.test(opt)) {
			return `${name} loading \`${eq < 0 ? `${a} ${args[i + 1] ?? ""}`.trim() : a}\` before the program: code the gate does not read`;
		}
		if (node && opt === "--redirect-warnings") {
			const why = envPath(`${name} ${opt}`, eq < 0 ? args[++i] : a.slice(eq + 1), w, writes);
			if (why) return why;
			continue;
		}
		return `${name} with \`${a}\`, an option the gate does not model`;
	}
	return null;
}

/** PERL5OPT / RUBYOPT: only the warning switches are modeled; `-M`/`-m`/`-r` load a module first. */
function switchesEnvUnmodeled(name: string, value: string): string | null {
	for (const a of value.split(/\s+/).filter((x) => x !== "")) {
		if (name === "PERL5OPT" ? /^-[wW]+$/.test(a) : /^(?:-w|-W[012]?|-W:(?:no-)?[\w-]+|--(?:disable|enable)[-=][\w,-]+)$/.test(a)) continue;
		if (name === "PERL5OPT" ? /^-[^-]*[Mm]/.test(a) : /^-[^-]*r|^--require/.test(a)) return `${name} loading a module (\`${a}\`) before the program: code the gate does not read`;
		return `${name} with \`${a}\`, a switch the gate does not model`;
	}
	return null;
}

/**
 * The interpreter environment the command string sets (astra-7 B3): the first reason it is not a
 * modeled form, and the files it makes an interpreter write (NODE_OPTIONS `--redirect-warnings`,
 * NODE_REDIRECT_WARNINGS), which rows 6 (.git) and 10 (the ledger) check as write destinations.
 * Modeled: INERT_INTERPRETER_ENV with any value; NODE_OPTIONS and BUN_OPTIONS of inert options and
 * a literal absolute warnings file; PERL5OPT/RUBYOPT warning switches; REPO_MODULE_PATH_ENV with
 * every entry inside the repository of each directory the assignment reaches. Refused: a value not
 * typed out as literal text, a preload (PRELOAD_ENV, `--require`/`--import`/`-M`/`-r`), any other
 * module path (MODULE_PATH_ENV, PYTHONHOME always), and every other member of the families.
 * Every occurrence is judged, and every write collected past an unmodeled one (astra-8 B1: a later
 * assignment does not undo what an earlier one did to the commands it reached).
 */
export function interpreterEnv(x: Pick<Expansion, "assigned" | "commands">, cwd: string): { unmodeled: string | null; writes: Word[] } {
	const writes: Word[] = [];
	let unmodeled: string | null = null;
	for (const [name, w] of occurrences(x.assigned)) {
		if (!INTERPRETER_ENV.test(name) || INERT_INTERPRETER_ENV.test(name)) continue;
		const why = interpreterAssignment(name, w, x, cwd, writes);
		unmodeled ??= why;
	}
	return { unmodeled, writes };
}

/** Why one assignment of an INTERPRETER_ENV member is not modeled, collecting the files it writes into `writes`. */
function interpreterAssignment(name: string, w: Word, x: Pick<Expansion, "commands">, cwd: string, writes: Word[]): string | null {
	if (!w.text.startsWith(`${name}=`)) return `${name} exported without a value the gate reads`;
	if (w.opaque || w.expanded) return `${name} set to a value not typed out as literal text (${w.text})`;
	const value = w.text.slice(name.length + 1);
	if (value === "") return null;
	if (PRELOAD_ENV.test(name)) return `${name}=${value}, a program or library run before the command: code the gate does not read`;
	if (REPO_MODULE_PATH_ENV.test(name)) return moduleOutsideRepo(name, value, assignmentDirs(x, w, cwd));
	if (MODULE_PATH_ENV.test(name)) return `${name}=${value}, which moves where modules are found, so a name may load code the gate does not read`;
	if (name === "NODE_OPTIONS" || name === "BUN_OPTIONS") return optionsEnvUnmodeled(name, value, w, writes);
	if (name === "PERL5OPT" || name === "RUBYOPT") return switchesEnvUnmodeled(name, value);
	if (name === "NODE_REDIRECT_WARNINGS") return envPath(name, value, w, writes);
	return `${name}=${value}, an interpreter setting the gate does not model`;
}

// The same environment at eval's shell boundary (M4 fix round 8, astra-8 B2): a process eval code
// starts gets the interpreter environment its shell literal sets (`Bun.$\`NODE_OPTIONS=… node\``) or
// its env object passes (`spawnSync(…, {env: {NODE_OPTIONS: …}})`, Python `subprocess.run(…, env={…})`,
// `process.env.X = …`, `os.environ["X"] = …`), so it is judged exactly as the bash branch judges it.

/**
 * The text eval (or inline interpreter) code may run as commands, or null when it starts no process.
 * Code with a spawn API may run any string it holds, so every literal and literal argv list outside
 * a comment counts; code whose only process start is Bun's shell tag runs its tagged templates
 * (astra-9 R1: `const o = {k: "--require=x"}; await Bun.$\`node -e 0\`` runs `node -e 0` only),
 * unless it calls the tag as a function (`Bun.$(…)`), whose argument may be any of its strings.
 */
export function codeCommands(facts: CodeFacts, family?: CodeFamily): string[] | null {
	if (SPAWN_API.test(facts.folded) || ((family === "perl" || family === "ruby") && SCRIPT_SPAWN_API.test(facts.folded))) return facts.codeLiterals;
	if (!BUN_SHELL_TAG.test(facts.folded)) return null;
	return /\bBun\s*\.\s*\$\s*\(/.test(facts.uncommented) ? facts.codeLiterals : facts.shellTags;
}

/** One string literal at the start of `s` (template literals without `${…}`): its body, or null. */
const LEADING_LITERAL = /^(?:"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`)/;
/** An environment name as an object key, keyword argument or assignment target: `NAME:`, `"NAME":`, `NAME=`, `.NAME =`. */
const ENV_KEY = /(?<![\w$])(["'`]?)([A-Za-z_]\w*)\1\s*(?::(?!:)|=(?![=>~]))\s*/g;
/** An environment name as a call's first argument with a value after it: `os.putenv("NAME", v)`, `os.environ.setdefault("NAME", v)`. */
const ENV_CALL_KEY = /\(\s*(["'])([A-Za-z_]\w*)\1\s*,\s*/g;

// What makes a key an environment setting (astra-9 R1): the construct it is bound to, never its spelling.
/** The object a `.NAME =` assignment sets a variable on (`process.env.X =`, `Bun.env.X =`, Python `os.environ["X"] =`, bracket keys already rewritten to `.X`). */
const ENV_OBJECT_MEMBER = /(?:\b(?:process|Bun|Deno)\s*\.\s*env|\benviron)\s*\.\s*$/;
/** What an object literal holding environment keys is bound to: an `env:`/`env=` option or keyword, or a replacement of the environment itself. */
const ENV_OBJECT_TARGET = /(?:(?<![\w$.])env|\b(?:process|Bun|Deno)\s*\.\s*env|\benviron)\s*(?::(?!:)|=(?![=>~]))\s*$/;
/** Calls whose arguments set environment variables: `$.env({…})`/`Bun.$\`…\`.env({…})`, `os.environ.update(…)`, `env=dict(…)`. */
const ENV_CALL = /\.\s*env\s*$|\benviron\s*\.\s*update\s*$|(?:(?<![\w$.])env\s*[:=]|\benviron\s*=)\s*dict\s*$/;
/** `Object.assign(process.env, …)`: the call and its first argument. */
const ENV_ASSIGN_CALL = /\bObject\s*\.\s*assign\s*$/;
const ENV_ASSIGN_FIRST = /^\s*(?:process|Bun|Deno)\s*\.\s*env\s*,/;
/** Calls whose first string argument names the variable they set: `os.putenv("X", v)`, `os.environ.setdefault("X", v)`. */
const ENV_NAMED_CALL = /\b(?:putenv|setenv)\s*$|\benviron\s*\.\s*setdefault\s*$/;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/**
 * An object handed to an environment-setting construct by name (`.env(e)`, `{env: e}`, `env=e`,
 * `Object.assign(process.env, e)`, `os.environ.update(e)`, `env=dict(e, …)`): its keys are bound too.
 * A dotted or called name (`process.env`, `os.environ`) is the environment itself, not a holder.
 */
const ENV_PASSED = new RegExp(
	String.raw`(?:\.\s*env\s*\(|(?<![\w$.])env\s*(?::(?!:)|=(?![=>~]))|\bObject\s*\.\s*assign\s*\(\s*(?:process|Bun|Deno)\s*\.\s*env\s*,|\benviron\s*\.\s*update\s*\(|(?:(?<![\w$.])env\s*[:=]|\benviron\s*=)\s*dict\s*\()\s*(${IDENT})(?![\w$]|\s*[.([])`,
	"g",
);
/** A name spread into an object (`...e`, Python `**e`): bound when that object is. */
const ENV_SPREAD = new RegExp(String.raw`(?:\.\.\.|\*\*)\s*(${IDENT})(?![\w$]|\s*[.([])`, "g");
/** A holder named right before a key (`e.NAME =`, Python `e["NAME"] =` rewritten to `e.NAME`). */
const HOLDER_MEMBER = new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*\.\s*$`);
/** A holder named right before an object literal (`const e = {…}`). */
const HOLDER_ASSIGN = new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*=(?![=>~])\s*$`);

/** The names of objects whose keys reach a child's environment (ENV_PASSED, and objects spread into a bound one). */
function envHolders(s: string): Set<string> {
	const names = new Set<string>();
	for (const m of s.matchAll(ENV_PASSED)) names.add(m[1]!);
	for (let grew = true; grew; ) {
		grew = false;
		for (const m of s.matchAll(ENV_SPREAD)) {
			if (names.has(m[1]!) || !envBound(s, m.index!, names)) continue;
			names.add(m[1]!);
			grew = true;
		}
	}
	return names;
}

/** The index of the innermost `(`, `[` or `{` still open at `at` in `s`, or -1. */
function enclosingOpen(s: string, at: number): number {
	let depth = 0;
	for (let i = at - 1; i >= 0; i--) {
		const c = s[i];
		if (c === ")" || c === "]" || c === "}") depth++;
		else if (c === "(" || c === "[" || c === "{") {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/** Whether the call whose `(` is at `open` in `s` sets environment variables from its arguments. */
function envCall(s: string, open: number): boolean {
	const before = s.slice(0, open);
	return ENV_CALL.test(before) || (ENV_ASSIGN_CALL.test(before) && ENV_ASSIGN_FIRST.test(s.slice(open + 1)));
}

/**
 * Whether the key at `at` in `s` (uncommented code) sets an environment variable: a member of the
 * process environment (or of a `holders` object) assigned, or a key of an object or keyword argument
 * list bound to an environment-setting construct. A key of any other object, or an assignment to a
 * plain identifier, is data (`const defaults = {NODE_OPTIONS: …}` sets nothing).
 */
function envBound(s: string, at: number, holders: Set<string>): boolean {
	const upTo = s.slice(0, at);
	if (ENV_OBJECT_MEMBER.test(upTo) || holders.has(HOLDER_MEMBER.exec(upTo)?.[1] ?? "")) return true;
	const open = enclosingOpen(s, at);
	if (open < 0) return false;
	if (s[open] === "(") return envCall(s, open);
	if (s[open] !== "{") return false;
	const before = s.slice(0, open);
	if (ENV_OBJECT_TARGET.test(before) || holders.has(HOLDER_ASSIGN.exec(before)?.[1] ?? "")) return true;
	if (!/[(,]\s*$/.test(before)) return false;
	const call = enclosingOpen(s, open);
	return call >= 0 && s[call] === "(" && envCall(s, call);
}

/**
 * The INTERPRETER_ENV members code sets outside its shell literals, by name, every occurrence as a
 * `NAME=value` word: a literal value as text, anything else opaque (not typed out as literal text).
 * A key is read on `folded` only where `uncommented` shows it is code or a whole literal of its own
 * (never a comment, never text inside another literal, which is expanded as shell instead), and only
 * where it is bound to an environment-setting construct (envBound, astra-9 R1).
 */
function codeEnvAssigns(facts: CodeFacts): Map<string, Word[]> {
	const { folded, uncommented } = facts;
	const out = new Map<string, Word[]>();
	const holders = envHolders(uncommented);
	for (const re of [ENV_KEY, ENV_CALL_KEY]) {
		for (const m of folded.matchAll(re)) {
			const name = m[2]!;
			if (!INTERPRETER_ENV.test(name) || INERT_INTERPRETER_ENV.test(name)) continue;
			const q = m[1]!;
			const at = m.index! + (re === ENV_CALL_KEY ? m[0].indexOf(q) : 0);
			const key = uncommented.slice(at, at + name.length + 2 * q.length);
			if (q === "" ? key !== name : key !== `${q}${"_".repeat(name.length)}${q}`) continue;
			if (re === ENV_CALL_KEY ? !ENV_NAMED_CALL.test(uncommented.slice(0, m.index!)) : !envBound(uncommented, at, holders)) continue;
			const pos = m.index! + m[0].length;
			const lit = LEADING_LITERAL.exec(folded.slice(pos));
			const complete = lit !== null && !(lit[3] ?? "").includes("${") && /^\s*(?:[,;)}\]\n]|$)/.test(folded.slice(pos + lit[0].length));
			const w: Word = complete
				? { text: `${name}=${(lit[1] ?? lit[2] ?? lit[3]!).replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c)}`, opaque: false }
				: { text: `${name}=${folded.slice(pos, pos + 60).split("\n")[0]}`, opaque: true };
			const seen = out.get(name);
			if (seen) seen.push(w);
			else out.set(name, [w]);
		}
	}
	return out;
}

/**
 * The interpreter environment of the processes eval (or inline interpreter) code starts: every command
 * it may run (codeCommands) expanded as the bash branch expands a command, plus the variables the code
 * sets for its children, through interpreterEnv. Nothing when the code starts no process.
 */
export function codeInterpreterEnv(code: string, family: CodeFamily | undefined, cwd: string, env: Record<string, string | undefined>): { unmodeled: string | null; writes: Word[] } {
	const facts = codeFacts(code, family);
	const writes: Word[] = [];
	let unmodeled: string | null = null;
	const commands = codeCommands(facts, family);
	if (commands === null) return { unmodeled, writes };
	const judged = commands.map((t) => interpreterEnv(expandShell(t, cwd, env), cwd));
	judged.push(interpreterEnv({ assigned: codeEnvAssigns(facts), commands: [] }, cwd));
	for (const j of judged) {
		writes.push(...j.writes);
		unmodeled ??= j.unmodeled;
	}
	return { unmodeled, writes };
}
