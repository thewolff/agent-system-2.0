// Lexical analysis of `eval` code (and inline `bun -e`/`python -c` code) for rows 6 and 10. The gate
// cannot run or type-check arbitrary code, so it reads what it can soundly read — string literals,
// constant concatenations, literal argv arrays — and fails closed where the code spawns a process
// or writes a file with arguments it cannot read (astra review B1, B2).

import { boundaryEnvName } from "../../ledger/src/authority";
import type { CodeFamily } from "./exec";

/** One string literal's value per match; template literals only when they have no `${…}`. */
const LITERAL = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`/g;

const unescape = (s: string): string => s.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);

/** Fold `"a" + "b"` into `"ab"` until nothing folds (quotes normalised to `"`). */
export function foldConcat(code: string): string {
	const pair = /(["'])((?:\\.|(?!\1)[^\\\n])*)\1\s*\+\s*(["'])((?:\\.|(?!\3)[^\\\n])*)\3/;
	let out = code;
	for (let n = 0; n < 1000; n++) {
		const m = pair.exec(out);
		if (!m) break;
		const joined = unescape(m[2]!) + unescape(m[4]!);
		out = out.slice(0, m.index) + JSON.stringify(joined) + out.slice(m.index + m[0].length);
	}
	return out;
}

export interface CodeFacts {
	/** The code with constant concatenations folded. */
	folded: string;
	/** Every string literal value (after folding). */
	literals: string[];
	/** Literal-only arrays joined with spaces: `["git","push","-f"]` → `git push -f`. */
	argvLists: string[];
	/** The folded code with every literal emptied: what is left is code, not text. */
	bare: string;
	/**
	 * The folded code with each literal's body blanked to `_` but its length kept, so a position in
	 * `masked` is the same position in `folded`: the call structure is read here, the argument text
	 * there (M4 fix round 4, B2: arguments are captured before erasure, never re-scanned after it).
	 */
	masked: string;
	/**
	 * `masked` with the comments of the code's family blanked, same length (`COMMENT`): the code a reader
	 * runs. A literal whose opening quote is blank here sits in a comment (astra-8 S1: `// "constructor"`).
	 */
	uncommented: string;
	/** `literals` then `argvLists`, less those inside a comment of the code's family: the text the code can run (astra-9 R1). */
	codeLiterals: string[];
	/** The bodies of `Bun.$\`…\`` templates without `${…}` outside comments: the commands Bun's shell tag runs. */
	shellTags: string[];
}

/** Words after which `[` opens an array literal, not a member access (`return ["a"]`, Python `in ["a"]`). */
const NOT_RECEIVER = /^(?:return|typeof|instanceof|in|of|yield|await|case|else|do|void|delete|new|throw|not|and|or|is|if|elif|while|for|lambda|assert|print|with|from|import|export|default|extends)$/;
/** A receiver followed by `[`: the word, `)` or `]` before it (the word group is empty for `)`/`]`). */
const MEMBER_OPEN = /([\w$]*)([\w$)\]])(\s*)\[/g;

/**
 * `x["ident"]`, `x['ident']` and `` x[`ident`] `` rewritten to `x.ident`, so a method named in a
 * string is read as the method (`f["writer"]()["write"]("x")` is `f.writer().write("x")`, astra-6 B8).
 * Everything else downstream (literals, bare, masked) is computed from the rewritten code.
 */
function dotAccess(code: string): string {
	const key = /^\[\s*(["'`])([A-Za-z_$][\w$]*)\1\s*\]/;
	let out = "";
	let last = 0;
	for (const m of code.matchAll(MEMBER_OPEN)) {
		if (NOT_RECEIVER.test(m[1]! + m[2]!)) continue;
		const open = m.index! + m[0].length - 1;
		const k = key.exec(code.slice(open));
		if (!k) continue;
		out += `${code.slice(last, m.index! + m[1]!.length + m[2]!.length)}.${k[2]}`;
		last = open + k[0].length;
	}
	return out + code.slice(last);
}

/**
 * The first member access whose key is computed at run time (`f[k]`, `f[a + b]`), or null. Keys the
 * gate reads are allowed: a string literal, a number or slice (`b[0]`, `b[-4:]`), or empty (`T[]`).
 * Code naming the ledger refuses one (astra-6 B8): the method it reaches cannot be named.
 */
export function computedMember(facts: CodeFacts): string | null {
	return firstComputedMember(facts.masked, facts.folded);
}

function firstComputedMember(masked: string, folded: string): string | null {
	for (const m of masked.matchAll(MEMBER_OPEN)) {
		if (NOT_RECEIVER.test(m[1]! + m[2]!)) continue;
		const inner = callArgs(masked, m.index! + m[0].length - 1);
		if (inner === null) return `${m[0]}…`;
		if (/^\s*(?:(["'`])_*\1|[\d\s:+-]*)\s*$/.test(inner)) continue;
		return `${m[0]}${folded.slice(m.index! + m[0].length, m.index! + m[0].length + inner.length)}]`;
	}
	return null;
}

/**
 * Comment syntax per code family, read on `masked` (string bodies are `_`, so a marker inside a string
 * is not a comment). JS: `//…` and `/* … *\/` (JSDoc included); `#` is a private name, not a comment.
 * Python: `#…`; `//` is floor division (`n = a // 2; open(p, "w")` is code). A family with no entry,
 * or code whose family is not known, blanks nothing: the gate reads it all as code.
 */
const COMMENT: Partial<Record<CodeFamily, RegExp>> = {
	js: /\/\*[\s\S]*?\*\/|(?<![:\w$])\/\/[^\n]*/g,
	python: /#[^\n]*/g,
};

/**
 * Bun's shell tag, `Bun.$\`…\`` and `Bun.$(…)`. SPAWN_API's `Bun\.\$\b` needs a word character after
 * `$`, so it misses both; code whose only process start is this tag runs its tagged templates, not
 * every string it holds (astra-9 R1).
 */
export const BUN_SHELL_TAG = /\bBun\s*\.\s*\$(?![\w$])/;

export function codeFacts(code: string, family?: CodeFamily): CodeFacts {
	const folded = dotAccess(foldConcat(code));
	const bare = folded.replace(LITERAL, (s) => (s.startsWith("`") && s.includes("${") ? s : `${s[0]}${s[0]}`));
	const masked = folded.replace(LITERAL, (s) => (s.startsWith("`") && s.includes("${") ? s : `${s[0]}${"_".repeat(s.length - 2)}${s[0]}`));
	const comment = family && COMMENT[family];
	const uncommented = comment ? masked.replace(comment, (s) => s.replace(/[^\n]/g, " ")) : masked;
	// A literal (or argv list) whose opening character is blanked in `uncommented` sits in a comment.
	const literals: string[] = [];
	const codeLiterals: string[] = [];
	for (const m of folded.matchAll(LITERAL)) {
		if (m[3] !== undefined && m[3].includes("${")) continue;
		const v = unescape(m[1] ?? m[2] ?? m[3] ?? "");
		literals.push(v);
		if (uncommented[m.index!] === m[0][0]) codeLiterals.push(v);
	}
	const argvLists: string[] = [];
	const lit = String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`;
	for (const m of folded.matchAll(new RegExp(String.raw`\[\s*(${lit}(?:\s*,\s*${lit})*)\s*,?\s*\]`, "g"))) {
		const v = [...m[1]!.matchAll(LITERAL)].map((x) => unescape(x[1] ?? x[2] ?? "")).join(" ");
		argvLists.push(v);
		if (uncommented[m.index!] === "[") codeLiterals.push(v);
	}
	const shellTags: string[] = [];
	for (const m of uncommented.matchAll(/\bBun\s*\.\s*\$\s*`/g)) {
		const body = /^`((?:\\.|[^`\\])*)`/.exec(folded.slice(m.index! + m[0].length - 1))?.[1];
		if (body !== undefined && !body.includes("${")) shellTags.push(unescape(body));
	}
	return { folded, literals, argvLists, bare, masked, uncommented, codeLiterals, shellTags };
}

/** APIs that start a process (JS/TS and Python spellings). */
export const SPAWN_API =
	/\bBun\s*\.\s*(?:\$|spawn|spawnSync)\b|(?:^|[^\w.])\$\s*`|\bchild_process\b|\b(?:execSync|execFileSync|spawnSync|execFile|execa|execaSync)\b|\bsubprocess\s*\.|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bDeno\s*\.\s*(?:Command|run)\b|\bshelljs\b|\bpty\s*\.\s*spawn\b/;

/**
 * Two views of eval code from one left-to-right scan (PLAN wl-muzs0ytnaet1v4 D1), each the length of
 * `text` with newlines kept, so a position in either view is the same position in `text`:
 * - `codeOnly`: string bodies (quotes kept), comments and regex-literal bodies are spaces;
 * - `codeAndStrings`: comments and regex-literal bodies are spaces; string bodies are kept.
 * In both, every `?.` outside strings and comments is ` .`, so an optional chain matches its plain
 * spelling. JS: `'…'`, `"…"`, template literals (static text is string, each `${…}` is scanned again
 * as code), `//` wherever it starts outside a string (`1// …` too), `/* … *\/`, and a regex literal
 * where an operand cannot end. Python: triple-quoted strings first (their close is found before any
 * `#`), single-quoted strings with r/b/u/f prefixes, f-string `{…}` fields as code, `#` comments.
 * Any other family is left as it is, `?.` folded: the gate reads it all as code (`COMMENT`'s rule).
 * `codeFacts` and `COMMENT` are unchanged; this feeds only D1 (`evalProcessStart`) and `evalLoads`.
 */
export function scanCode(text: string, family?: CodeFamily): { codeOnly: string; codeAndStrings: string } {
	const n = text.length;
	const only = text.split("");
	const both = text.split("");
	/** Spaces over [from, to) in codeOnly, and in codeAndStrings too when `all`; newlines kept. */
	const blank = (from: number, to: number, all: boolean) => {
		for (let k = from; k < Math.min(to, n); k++) {
			if (text[k] === "\n") continue;
			only[k] = " ";
			if (all) both[k] = " ";
		}
	};
	const fold = (at: number) => {
		only[at] = " ";
		both[at] = " ";
	};
	/** The index of the quote closing a one-line string opened at `open`, or the line end when unclosed. */
	const lineStringClose = (open: number, q: string): number => {
		let j = open + 1;
		while (j < n && text[j] !== q && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
		return Math.min(j, n);
	};

	/** JS code from `start`; inside a template's `${`, returns at its closing `}`. */
	const js = (start: number, inTemplate: boolean): number => {
		let depth = 0;
		let lastSig = ""; // the last significant code character; "w" after a word; "c" after the `)` closing a statement head
		let lastWord = "";
		let prevWord = ""; // the word before `lastWord` when the two are adjacent (`for await`)
		let wordAfterDot = false; // `lastWord` is a member name (`a.if`), not a keyword
		const heads: boolean[] = []; // one per open `(`: whether it opens the head of `if`/`while`/`for`/`with`
		let i = start;
		while (i < n) {
			const c = text[i]!;
			if (/\s/.test(c)) {
				i++;
				continue;
			}
			if (c === "/" && text[i + 1] === "/") {
				const end = text.indexOf("\n", i);
				blank(i, end < 0 ? n : end, true);
				i = end < 0 ? n : end;
				continue;
			}
			if (c === "/" && text[i + 1] === "*") {
				const close = text.indexOf("*/", i + 2);
				const end = close < 0 ? n : close + 2;
				blank(i, end, true);
				i = end;
				continue;
			}
			if (c === "/" && (lastSig === "" || lastSig === "c" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || (lastSig === "w" && JS_REGEX_AFTER.test(lastWord)))) {
				const close = regexClose(text, i);
				if (close !== null) {
					blank(i + 1, close, true);
					i = close + 1;
					while (i < n && /[A-Za-z]/.test(text[i]!)) i++;
					lastSig = "w";
					lastWord = "";
					continue;
				}
			}
			if (c === '"' || c === "'") {
				const close = lineStringClose(i, c);
				blank(i + 1, close, false);
				i = close + 1;
				lastSig = c;
				lastWord = "";
				continue;
			}
			if (c === "`") {
				let j = i + 1;
				while (j < n && text[j] !== "`") {
					if (text[j] === "\\") {
						blank(j, j + 2, false);
						j += 2;
					} else if (text[j] === "$" && text[j + 1] === "{") {
						j = js(j + 2, true) + 1;
					} else {
						blank(j, j + 1, false);
						j++;
					}
				}
				i = j + 1;
				lastSig = "`";
				lastWord = "";
				continue;
			}
			if (c === "?" && text[i + 1] === "." && !/\d/.test(text[i + 2] ?? "")) {
				fold(i);
				i += 2;
				lastSig = ".";
				lastWord = "";
				continue;
			}
			if (/[\w$]/.test(c)) {
				let j = i;
				while (j < n && /[\w$]/.test(text[j]!)) j++;
				wordAfterDot = lastSig === ".";
				prevWord = lastSig === "w" ? lastWord : "";
				lastWord = text.slice(i, j);
				lastSig = "w";
				i = j;
				continue;
			}
			if (c === "(") heads.push(lastSig === "w" && !wordAfterDot && (JS_STATEMENT_HEAD.test(lastWord) || (lastWord === "await" && prevWord === "for")));
			if (c === "{") depth++;
			if (c === "}") {
				if (inTemplate && depth === 0) return i;
				depth--;
			}
			// A `/` after the `)` closing `if (…)` starts a statement, so it opens a regex; after any other `)` it divides.
			lastSig = c === ")" && heads.pop() ? "c" : c;
			lastWord = "";
			i++;
		}
		return n;
	};

	/** Python code from `start`; inside an f-string field, returns at its closing `}`. */
	const py = (start: number, inField: boolean): number => {
		let depth = 0;
		let i = start;
		while (i < n) {
			const c = text[i]!;
			if (c === "#") {
				const end = text.indexOf("\n", i);
				blank(i, end < 0 ? n : end, true);
				i = end < 0 ? n : end;
				continue;
			}
			const prefix = /^[rRbBuUfF]{0,2}(?=["'])/.exec(text.slice(i, i + 3));
			if (prefix && (c === '"' || c === "'" || !/[\w$]/.test(text[i - 1] ?? ""))) {
				const open = i + prefix[0].length;
				const q = text[open]!;
				const triple = text.startsWith(q.repeat(3), open);
				const fstring = /[fF]/.test(prefix[0]);
				let j = open + (triple ? 3 : 1);
				while (j < n) {
					if (text[j] === "\\") {
						blank(j, j + 2, false);
						j += 2;
					} else if (triple ? text.startsWith(q.repeat(3), j) : text[j] === q || text[j] === "\n") {
						break;
					} else if (fstring && text[j] === "{") {
						if (text[j + 1] === "{") {
							blank(j, j + 2, false);
							j += 2;
						} else {
							j = py(j + 1, true) + 1;
						}
					} else {
						blank(j, j + 1, false);
						j++;
					}
				}
				i = j < n && text[j] !== "\n" ? j + (triple ? 3 : 1) : j;
				continue;
			}
			if (/[\w$]/.test(c)) {
				while (i < n && /[\w$]/.test(text[i]!)) i++;
				continue;
			}
			if (c === "?" && text[i + 1] === ".") {
				fold(i);
				i += 2;
				continue;
			}
			if (c === "{") depth++;
			if (c === "}") {
				if (inField && depth === 0) return i;
				depth--;
			}
			i++;
		}
		return n;
	};

	if (family === "js") js(0, false);
	else if (family === "python") py(0, false);
	else for (let k = text.indexOf("?."); k >= 0; k = text.indexOf("?.", k + 2)) fold(k);
	return { codeOnly: only.join(""), codeAndStrings: both.join("") };
}

/** Words after which a JS `/` opens a regex literal, not a division. */
const JS_REGEX_AFTER = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
/** Keywords whose parenthesised head is followed by a statement, where a `/` opens a regex literal. */
const JS_STATEMENT_HEAD = /^(?:if|while|for|with)$/;

/** The index of the `/` closing a JS regex literal opened at `open`, or null when none closes it on its line. */
function regexClose(text: string, open: number): number | null {
	let inClass = false;
	for (let j = open + 1; j < text.length; j++) {
		const c = text[j];
		if (c === "\\") j++;
		else if (c === "\n") return null;
		else if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return j;
	}
	return null;
}

/** Python modules that start processes, however imported (`import X`, `import X as Y`, `from X import …`). */
const PY_PROCESS_MODULE = /^(?:subprocess|pty|pexpect|multiprocessing)(?:\.|$)/;
/** `os` / `posix` functions that start processes. */
const OS_PROCESS_FN = String.raw`(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*)`;
const OS_PROCESS_CALL = new RegExp(String.raw`(?<![\w$.])(?:os|posix)\s*\.\s*${OS_PROCESS_FN}(?![\w$])`);
/** Process starts named anywhere in code: `ProcessPoolExecutor`, `asyncio.create_subprocess_exec/_shell`. */
const PY_PROCESS_NAME = /(?<![\w$])(?:ProcessPoolExecutor|create_subprocess_(?:exec|shell))(?![\w$])/;
/** An import statement at a line start, after `;`, or after the `:` of a one-line compound statement (`if x: import …`, `try: from …`). */
const PY_IMPORT_STMT = /(?:^|[\n;:])[ \t]*import[ \t]+([^\n;]+)/g;
const PY_FROM_STMT = /(?:^|[\n;:])[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]*(\([^)]*\)|[^\n;]+)/g;
/** Names bound from `bun` that start processes. */
const BUN_SPAWN_NAME = /^(?:spawn|spawnSync|\$)$/;
const JS_BUN_IMPORT = /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(["'`])(\s*)\2/g;
const JS_BUN_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*Bun(?![\w$])(?!\s*\.)/;
const JS_DYNAMIC_LOAD = /\b(?:import|require)\s*\(\s*(["'`])(\s*)\1\s*\)/g;
/** The eval tool's magics that start a process, at a line start: Python's, then JS's. */
const PY_PROCESS_MAGIC = /^[ \t]*(?:!(?!=)|%(?:sh|system|sx|pip|conda)\b|%%(?:bash|sh|script)\b)/m;
const JS_PROCESS_MAGIC = /^[ \t]*%bun\b/m;
/** The nested bash tool by member (`tool.bash`, `tool?.bash` folded, `tool . bash`), and by bracket with its key in `folded`. */
const TOOL_BASH = /\btool\s*\.\s*bash\b/;
const TOOL_BRACKET = /\btool\s*\.?\s*\[\s*(["'`])(\s*)\1\s*\]/g;

/** The body of the string literal whose blanked body (`len` spaces in a view) starts at `at`, read from `folded`. */
const bodyAt = (folded: string, at: number, len: number) => folded.slice(at, at + len).trim();
/** The names a destructuring or import list binds from its source (`spawn`, `spawn as s`, `spawn: s`). */
const sourceNames = (list: string) => list.split(",").map((s) => s.trim().split(/\s+as\s+|\s*:\s*/)[0]!.trim());

/**
 * The first process start in eval code, as the spelling found, or null (PLAN wl-muzs0ytnaet1v4 D1):
 * (a) SPAWN_API or Bun's shell tag on `codeAndStrings` (a module named in a string still counts; a
 * comment or regex literal does not); (b) the gap spellings on `codeOnly`: Python process modules
 * imported in any form, `os`/`posix` process functions under any binding, `ProcessPoolExecutor`,
 * `create_subprocess_*`, and the `bun` module's `spawn`/`spawnSync`/`$` imported or destructured, or
 * the module loaded by `import()`/`require()` at all; (c) the eval tool's process magics at a line
 * start; (d) the nested bash tool, referenced in any member spelling.
 */
export function evalProcessStart(facts: CodeFacts, family?: CodeFamily): string | null {
	const { folded } = facts;
	const { codeOnly, codeAndStrings } = scanCode(folded, family);
	// (a)
	const a = SPAWN_API.exec(codeAndStrings) ?? BUN_SHELL_TAG.exec(codeAndStrings);
	if (a) {
		const word = a[0].endsWith(".") ? (/^\w*/.exec(codeAndStrings.slice(a.index + a[0].length))?.[0] ?? "") : "";
		return `${a[0].trim()}${word}`.replace(/\s+/g, "");
	}
	// (b) Python
	const osAliases: string[] = [];
	for (const m of codeOnly.matchAll(PY_IMPORT_STMT)) {
		for (const item of m[1]!.split(",")) {
			const im = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
			if (!im) continue;
			if (PY_PROCESS_MODULE.test(im[1]!)) return `import ${im[1]}`;
			if ((im[1] === "os" || im[1] === "posix") && im[2]) osAliases.push(im[2]);
		}
	}
	for (const m of codeOnly.matchAll(PY_FROM_STMT)) {
		if (PY_PROCESS_MODULE.test(m[1]!)) return `from ${m[1]} import`;
		if (m[1] !== "os" && m[1] !== "posix") continue;
		const names = sourceNames(m[2]!.replace(/[()]/g, ""));
		const hit = names.find((x) => x === "*" || new RegExp(`^${OS_PROCESS_FN}$`).test(x));
		if (hit) return `from ${m[1]} import ${hit}`;
	}
	const os = OS_PROCESS_CALL.exec(codeOnly) ?? PY_PROCESS_NAME.exec(codeOnly);
	if (os) return os[0].replace(/\s+/g, "");
	for (const alias of osAliases) {
		const m = new RegExp(String.raw`(?<![\w$.])${alias}\s*\.\s*${OS_PROCESS_FN}(?![\w$])`).exec(codeOnly);
		if (m) return m[0].replace(/\s+/g, "");
	}
	// (b) JS: the `bun` module's process starts.
	for (const m of codeOnly.matchAll(JS_BUN_IMPORT)) {
		const at = m.index! + m[0].length - m[3]!.length - 1;
		if (bodyAt(folded, at, m[3]!.length) === "bun" && sourceNames(m[1]!).some((x) => BUN_SPAWN_NAME.test(x))) return 'import {…} from "bun"';
	}
	const d = JS_BUN_DESTRUCTURE.exec(codeOnly);
	if (d && sourceNames(d[1]!).some((x) => BUN_SPAWN_NAME.test(x))) return "const {…} = Bun";
	for (const m of codeOnly.matchAll(JS_DYNAMIC_LOAD)) {
		const at = m.index! + m[0].indexOf(m[1]!) + 1;
		if (bodyAt(folded, at, m[2]!.length) === "bun") return `${m[0].startsWith("require") ? "require" : "import"}("bun")`;
	}
	// (c)
	const magic = (family !== "js" ? PY_PROCESS_MAGIC.exec(codeOnly) : null) ?? (family !== "python" ? JS_PROCESS_MAGIC.exec(codeOnly) : null);
	if (magic) return folded.slice(magic.index).split("\n", 1)[0]!.trim().slice(0, 60);
	// (d)
	if (TOOL_BASH.test(codeOnly)) return "tool.bash";
	for (const m of codeOnly.matchAll(TOOL_BRACKET)) {
		const at = m.index! + m[0].indexOf(m[1]!) + 1;
		if (bodyAt(folded, at, m[2]!.length) === "bash") return 'tool["bash"]';
	}
	return null;
}

/**
 * The argument text of each live `%load` line (a line start in `codeOnly`, read from `folded`): the
 * magic runs a script file whose text the cell does not show (PLAN wl-muzs0ytnaet1v4 D1 (e)).
 */
export function evalLoads(facts: CodeFacts, family?: CodeFamily): string[] {
	const { codeOnly } = scanCode(facts.folded, family);
	return [...codeOnly.matchAll(/^[ \t]*%load\b[^\n]*/gm)].map((m) => {
		const line = facts.folded.slice(m.index!, m.index! + m[0].length);
		return line.replace(/^[ \t]*%load\b/, "").trim();
	});
}

/** Call names that take a command or argv, inside code that uses a spawn API. */
const SPAWN_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|execa|execaSync|system|popen|Popen|run|call|check_call|check_output|getoutput|getstatusoutput|Command)\s*\(/g;

/** The argument text of the call whose `(` is at `open`, with nested brackets kept; null if unbalanced. */
export function callArgs(bare: string, open: number): string | null {
	let depth = 0;
	for (let i = open; i < bare.length; i++) {
		const c = bare[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return bare.slice(open + 1, i);
	}
	return null;
}

/** A call's argument text split at its top-level commas, each trimmed. */
export function topLevelArgs(args: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const c of args) {
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		if (c === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else cur += c;
	}
	out.push(cur.trim());
	return out;
}

/** Process-starting spellings in Perl and Ruby: `system`, `exec`, `spawn`, `qx`, `%x`, backticks, `IO.popen`, `Open3`, a pipe `open`. */
export const SCRIPT_SPAWN_API =
	/(?<![\w$@%:.>-])(?:system|exec|spawn|readpipe|qx)\b|%x|`|\bIO\s*\.\s*popen\b|\bOpen3\b|\bProcess\s*\.\s*spawn\b|\bKernel\s*\.\s*(?:system|exec|spawn)\b|(?<![\w$])open\s*\(?[^;\n]*["'](?:[^"'\n]*\||-\|)/;

/** A Perl or Ruby spawn word whose arguments run to the end of the statement (`system join(…)`, `exec $cmd`). */
const SCRIPT_SPAWN_CALL = /(?<![\w$@%:.>-])(?:system|exec|spawn|readpipe)\b|\bIO\s*\.\s*popen\b|\bProcess\s*\.\s*spawn\b/g;

/**
 * Why the code starts a process with arguments the gate cannot read, or null. A tagged template
 * with `${…}` (`Bun.$\`${argv}\``) or a spawn call with a non-literal argument is unreadable. For
 * Perl and Ruby (astra review round 2, R2-B2: `perl -e 'system join("","r","m -r","f …")'`) a spawn
 * whose arguments are not plain literals, `qx`/`%x`, or an interpolating backtick or string is unreadable.
 */
export function opaqueSpawn(facts: CodeFacts, family?: CodeFamily): string | null {
	if (family === "perl" || family === "ruby") {
		if (!SCRIPT_SPAWN_API.test(facts.folded)) return null;
		if (/(?<![\w$@%:.>-])qx\b|%x/.test(facts.bare)) return "a qx/%x command the gate does not read";
		// Perl and Ruby strings interpolate (`"rm $x"`, `"r#{m}"`): a literal that does is not text the gate can read.
		for (const m of facts.folded.matchAll(LITERAL)) {
			const body = m[1] ?? m[3];
			if (body !== undefined && /[$@][\w{]|#\{/.test(body)) return `a string that interpolates values (${m[0].slice(0, 80)}) in code that starts processes`;
		}
		for (const m of facts.bare.matchAll(SCRIPT_SPAWN_CALL)) {
			const after = m.index! + m[0].length;
			const open = /^\s*\(/.exec(facts.bare.slice(after));
			const args = open ? callArgs(facts.bare, after + open[0].length - 1) : (/^[^;\n}]*/.exec(facts.bare.slice(after))?.[0] ?? "");
			if (args === null) return `a ${m[0]} call the gate could not read to its end`;
			const rest = args.replace(/(["'`])\1/g, "").replace(/[\s,[\]()]/g, "");
			if (rest !== "") return `a ${m[0]} call whose arguments are computed (${args.trim().slice(0, 80)})`;
		}
		return null;
	}
	const spawnApi = SPAWN_API.test(facts.folded);
	if (!spawnApi && !BUN_SHELL_TAG.test(facts.folded)) return null;
	if (/(?:\bBun\s*\.\s*\$|(?:^|[^\w.])\$)\s*`(?:\\.|[^`\\])*\$\{/.test(facts.folded)) return "a shell template (`$`…`) interpolating values the gate cannot read";
	// Code whose only process start is Bun's shell tag has no spawn calls to read (`re.exec(s)` is not one).
	if (!spawnApi) return null;
	for (const m of facts.bare.matchAll(SPAWN_CALL)) {
		const args = callArgs(facts.bare, m.index! + m[0].length - 1);
		if (args === null) return `a ${m[0].slice(0, -1).trim()}(…) call the gate could not read to its end`;
		// Drop option objects (`{ cwd: dir }`), empty literals and punctuation; anything left is a value the gate cannot read.
		const rest = args.replace(/\{[^{}]*\}/g, "").replace(/(["'`])\1/g, "").replace(/[\s,[\]()]/g, "");
		if (rest !== "") return `a ${m[0].slice(0, -1).trim()}(…) call whose arguments are computed (${args.trim().slice(0, 80)})`;
	}
	return null;
}

// ---- the Jo-only boundary, layer 2 (PLAN wl-mv654hoqwpfhmo § 6.3 item 2; ledger/src/authority.ts) -----------

/** A module specifier naming the ledger module or any file in it (`../ledger/src/index.ts`, `./ledger/src/locality`, `…/ledger/src`). */
const LEDGER_MODULE_SPEC = /(?:^|\/)ledger\/src(?:\/|$)/;
/** Module specifiers: `… from "x"`, a bare `import "x"`, `import("x")`, `require("x")`. */
const IMPORT_SPEC = /(?<![\w$.])(?:from|import|require)\s*\(?\s*(["'`])([^"'`\n]*)\1/g;

/** A match at `at` in `folded` that is code, not text inside a literal or a comment. */
const isCode = (facts: CodeFacts, at: number) => facts.uncommented[at] === facts.folded[at];

/** The first module specifier, outside comments and literals, that loads the ledger module, or null. */
export function ledgerModuleImport(facts: CodeFacts): string | null {
	for (const m of facts.folded.matchAll(IMPORT_SPEC)) {
		if (isCode(facts, m.index!) && LEDGER_MODULE_SPEC.test(m[2]!)) return m[2]!;
	}
	return null;
}

/** `import(` or `require(` whose first argument is not one plain string literal (masked to `"___"`; more arguments may follow). */
const DYNAMIC_LOAD = /(?<![\w$.])(?:import|require)\s*\(\s*(?!(["'`])_*\1\s*[,)])/;
/** `require` as a value (aliased or passed on): not called, not a member read (`require.resolve`), not an object key. */
const REQUIRE_VALUE = /(?<![\w$.])require(?![\w$])(?!\s*[(.:])/g;
/** A declaration binding `require` itself, or `typeof require`: names, not a load. */
const REQUIRE_NAMED = /(?:\b(?:const|let|var|function|typeof)\s+)$/;
/** A name bound to `createRequire(…)`: a require function under another name. */
const REQUIRE_FACTORY = /(?<![\w$.])(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*\.\s*)?createRequire\s*\(/g;

/**
 * `code` with the static text of each template literal that has `${…}` masked to `_`, its substitutions kept as
 * code, so text such as `` `run require(${x})` `` is not read as a load (G1 review round 1). codeFacts leaves such a
 * template unmasked. A template the scan cannot pair (a nested template, a `}` with no `${`) is left as it is.
 * Lengths are kept, so an index into the result is an index into `folded`.
 */
function maskTemplateText(code: string): string {
	return code.replace(/`((?:\\.|[^`\\])*)`/g, (t) => {
		let out = "`";
		let depth = 0;
		for (let i = 1; i < t.length - 1; i++) {
			const c = t[i]!;
			if (depth === 0 && c === "\\") {
				out += "__";
				i++;
			} else if (c === "$" && t[i + 1] === "{") {
				depth++;
				out += "${";
				i++;
			} else if (depth > 0 && c === "{") {
				depth++;
				out += c;
			} else if (c === "}") {
				if (depth === 0) return t;
				depth--;
				out += c;
			} else out += depth > 0 ? c : "_";
		}
		return depth === 0 ? `${out}\`` : t;
	});
}

/** JS `eval(…)`, `Function(…)` or `new Function(…)`: code built from its arguments (G1 review round 2, finding 2). */
const JS_CODE_RUN = /(?<![\w$.])(?:new\s+)?(?:eval|Function)\s*\(/g;

/**
 * The first module acquisition in JS code whose specifier the gate cannot read, or null (G1, scratch
 * auth-forgery AUDIT.md § (a)): an `import()` or `require()` whose first argument is not one literal string,
 * `require` taken as a value (`const r = require; r(p)`), a `createRequire` result called with a computed
 * argument, or `eval`/`Function` on code that is not one literal string each (`eval(readFileSync(p, "utf8"))`, G1
 * review round 2). The specifier may name the ledger module (`["…", "ledger", "src", "index"].join("/")`), so the gate
 * refuses what it cannot name. Read on `uncommented` (string bodies masked, comments blanked) with the static
 * text of `${…}` templates masked too (maskTemplateText).
 */
export function computedModuleLoad(facts: CodeFacts): string | null {
	const code = maskTemplateText(facts.uncommented);
	const show = (at: number) => facts.folded.slice(at, at + 60).split("\n")[0]!.trim();
	const load = DYNAMIC_LOAD.exec(code);
	if (load) return show(load.index);
	for (const m of code.matchAll(REQUIRE_VALUE)) {
		if (!REQUIRE_NAMED.test(code.slice(Math.max(0, m.index! - 20), m.index!))) return show(m.index!);
	}
	for (const f of code.matchAll(REQUIRE_FACTORY)) {
		const call = new RegExp(String.raw`(?<![\w$.])${f[1]!.replaceAll("$", "\\$")}\s*\(\s*(?!(["'\`])_*\1\s*[,)])`).exec(code);
		if (call) return show(call.index);
	}
	for (const m of code.matchAll(JS_CODE_RUN)) {
		const args = argTexts(facts, m.index! + m[0].length - 1);
		if (args === null || args.some((a) => !PLAIN_LITERAL.test(a))) return show(m.index!);
	}
	return null;
}

/** A string literal with no interpolation: a target the gate can read. */
export const PLAIN_LITERAL = /^(?:(["'])[^"'\\]*\1|`[^`$\\]*`)$/;

/** A call's top-level arguments as spans of `folded`, split on `masked` (same positions); null if unbalanced. */
export function argTexts(facts: CodeFacts, open: number): string[] | null {
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

/** The module specifiers JS code loads, outside comments and literals (`from "x"`, `import "x"`, `import("x")`, `require("x")`). */
export function moduleSpecifiers(facts: CodeFacts): string[] {
	return [...facts.folded.matchAll(IMPORT_SPEC)].filter((m) => isCode(facts, m.index!)).map((m) => m[2]!);
}

/**
 * Python's loads of code by path or by module name: group 1 a builtin called bare (`exec`, `eval`, `compile`,
 * `execfile`, `__import__`; `re.compile` is a method, not this), group 2 a loader reached on any receiver
 * (`runpy.run_path`, `importlib.import_module`, `importlib.util.spec_from_file_location`, `SourceFileLoader`,
 * `imp.load_source`, `site.addsitedir`).
 */
const PY_LOAD_CALL =
	/(?<![\w$.])(exec|eval|compile|execfile|__import__)\s*\(|(?<![\w$])(?:[\w$]+\s*\.\s*)*(run_path|run_module|import_module|spec_from_file_location|SourceFileLoader|load_source|addsitedir)\s*\(/g;
/** A file's text read in one expression: `open("p").read()`, `io.open("p", "r").read()`, `Path("p").read_text()`. */
const PY_FILE_READ = /^(?:(?:io|codecs)\s*\.\s*)?open\s*\(\s*((["'])[^"'\\]*\2)[^()]*\)\s*\.\s*read\s*\(\s*\)$|^(?:pathlib\s*\.\s*)?Path\s*\(\s*((["'])[^"'\\]*\4)\s*\)\s*\.\s*read_(?:text|bytes)\s*\(\s*\)$/;
/** A write to `sys.path`: `insert`/`append`/`extend`, `+=`, assignment, slice assignment. */
const PY_SYS_PATH = /(?<![\w$.])sys\s*\.\s*path\s*(?:\.\s*(insert|append|extend)\s*\(|(\+=|=(?!=)|\[[^\]\n]*\]\s*=(?!=)))/g;

/** What Python code loads (G1 review round 2, findings 2 and 4): files by literal path, modules by name, the directories it puts on sys.path, literal code it runs, and the first load whose target is computed. */
export interface PythonLoads {
	paths: string[];
	modules: string[];
	dirs: string[];
	texts: string[];
	computed: string | null;
}

/**
 * Python code's loads (PythonLoads): `exec`/`eval`/`compile` of a literal (its text) or of one file read
 * (`open(p).read()`, `Path(p).read_text()`), `runpy.run_path`, `execfile`, `spec_from_file_location`,
 * `SourceFileLoader`, `load_source` (a path), `__import__`, `import_module`, `run_module` and statement imports (a
 * module), and `sys.path` writes and `site.addsitedir` (a directory). An argument that is not a plain literal is a
 * load the gate cannot name (`computed`).
 */
export function pythonLoads(facts: CodeFacts): PythonLoads {
	const out: PythonLoads = { paths: [], modules: [], dirs: [], texts: [], computed: null };
	const code = facts.uncommented;
	const value = (a: string | undefined): string | null => (a !== undefined && PLAIN_LITERAL.test(a) ? a.slice(1, -1) : null);
	const computed = (at: number) => {
		out.computed ??= facts.folded.slice(at, at + 60).split("\n")[0]!.trim();
	};
	const take = (into: string[], a: string | undefined, at: number) => {
		const v = value(a);
		if (v === null) computed(at);
		else into.push(v);
	};
	const literalList = (a: string | undefined, at: number) => {
		const items = a !== undefined && /^[[(].*[\])]$/s.test(a) ? topLevelArgs(a.slice(1, -1)).filter((x) => x !== "") : null;
		if (items === null || items.some((x) => value(x) === null)) computed(at);
		else out.dirs.push(...items.map((x) => value(x)!));
	};
	for (const m of code.matchAll(PY_LOAD_CALL)) {
		const name = m[1] ?? m[2]!;
		const args = argTexts(facts, m.index! + m[0].length - 1);
		if (args === null) {
			computed(m.index!);
			continue;
		}
		if (name === "exec" || name === "eval" || name === "compile") {
			const a = args[0];
			const text = value(a);
			if (text !== null) out.texts.push(text);
			else if (a !== undefined && /^compile\s*\(/.test(a)) continue; // judged as its own call
			else {
				const read = a === undefined ? null : PY_FILE_READ.exec(a);
				take(out.paths, read?.[1] ?? read?.[3], m.index!);
			}
		} else if (name === "execfile" || name === "run_path") take(out.paths, args[0], m.index!);
		else if (name === "spec_from_file_location" || name === "SourceFileLoader" || name === "load_source") take(out.paths, args[1], m.index!);
		else if (name === "addsitedir") take(out.dirs, args[0], m.index!);
		else take(out.modules, args[0], m.index!);
	}
	for (const m of code.matchAll(PY_SYS_PATH)) {
		if (m[1] === "insert") take(out.dirs, argTexts(facts, m.index! + m[0].length - 1)?.[1], m.index!);
		else if (m[1] === "append") take(out.dirs, argTexts(facts, m.index! + m[0].length - 1)?.[0], m.index!);
		else if (m[1] === "extend") literalList(argTexts(facts, m.index! + m[0].length - 1)?.[0], m.index!);
		else literalList(facts.folded.slice(m.index! + m[0].length).split("\n")[0]!.trim(), m.index!);
	}
	for (const m of code.matchAll(PY_IMPORT_STMT)) {
		for (const item of m[1]!.split(",")) {
			const name = /^\s*([\w.]+)/.exec(item)?.[1];
			if (name) out.modules.push(name);
		}
	}
	// `from . import x` is relative to the importing package, which the gate does not resolve.
	for (const m of code.matchAll(PY_FROM_STMT)) if (!m[1]!.startsWith(".")) out.modules.push(m[1]!);
	return out;
}

/** The process environment as a receiver: `process.env`, `Bun.env`, Python's `os.environ` or a bare `environ`. */
const ENV = String.raw`(?:(?<![\w$.])(?:process|Bun)\s*\.\s*env|(?<![\w$.])(?:os\s*\.\s*)?environ)`;
/** Writes to one variable; group 1 is its name. Bracket keys are already member names (`dotAccess`). */
const ENV_NAME_WRITES: readonly [RegExp, string][] = [
	[new RegExp(String.raw`${ENV}\s*\.\s*([A-Za-z_]\w*)\s*(?:\?\?|\|\||&&|[-+*/%&|^])?=(?!=)`, "g"), "sets"],
	[new RegExp(String.raw`(?<![\w$.])(?:delete|del)\s+${ENV}\s*\.\s*([A-Za-z_]\w*)`, "g"), "unsets"],
	[new RegExp(String.raw`${ENV}\s*\.\s*(?:pop|setdefault|__setitem__|__delitem__)\s*\(\s*["'\`]([A-Za-z_]\w*)["'\`]`, "g"), "sets or unsets"],
	[new RegExp(String.raw`(?<![\w$.])(?:os\s*\.\s*)?(?:putenv|unsetenv)\s*\(\s*["'\`]([A-Za-z_]\w*)["'\`]`, "g"), "sets or unsets"],
	[new RegExp(String.raw`(?<![\w$.])(?:Reflect\s*\.\s*(?:set|deleteProperty|defineProperty)|Object\s*\.\s*defineProperty)\s*\(\s*${ENV}\s*,\s*["'\`]([A-Za-z_]\w*)["'\`]`, "g"), "sets or unsets"],
];
/** Writes to the whole environment: replacing or clearing it drops every agent-context tag. */
const ENV_REPLACE = new RegExp(String.raw`${ENV}\s*=(?!=)|${ENV}\s*\.\s*clear\s*\(`);
/** Bulk writes, which reach the names their arguments carry. */
const ENV_BULK = new RegExp(String.raw`(?<![\w$.])Object\s*\.\s*assign\s*\(\s*${ENV}\s*,|${ENV}\s*\.\s*update\s*\(`);

/**
 * Why eval code sets, unsets or overrides a name only Jo's machinery sets (the agent-context tags,
 * AGENT_SYSTEM_LEDGER_DB, AS2_TEST_*: `boundaryEnvName`), or null. Reading the environment stays allowed.
 */
export function boundaryEnvWrite(facts: CodeFacts): string | null {
	for (const [re, verb] of ENV_NAME_WRITES) {
		for (const m of facts.folded.matchAll(re)) {
			if (isCode(facts, m.index!) && boundaryEnvName(m[1]!)) return `code that ${verb} ${m[1]} (${m[0].trim().slice(0, 60)})`;
		}
	}
	const replace = ENV_REPLACE.exec(facts.uncommented);
	if (replace) return `code that replaces or clears the whole environment (${replace[0].trim()}), the agent-context tags included`;
	const bulk = ENV_BULK.exec(facts.uncommented);
	const named = bulk ? /(?<![\w$])(?:AGENT_SYSTEM_\w+|AS2_TEST_\w*)/.exec(facts.folded) : null;
	if (named && boundaryEnvName(named[0])) return `code that writes ${named[0]} into the environment (${bulk![0].trim()})`;
	return null;
}

/** Constructors `new` may name in code that loads a database module: builtins that open no file. */
const SAFE_BUILTIN = /^(?:Map|Set|WeakMap|WeakSet|WeakRef|Array|Object|Date|RegExp|Promise|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|URL|URLSearchParams|TextEncoder|TextDecoder|ArrayBuffer|SharedArrayBuffer|DataView|(?:Big)?(?:Int|Uint|Float)(?:8|16|32|64)(?:Clamped)?Array|Blob|Headers|Request|Response|AbortController|FormData|Intl\s*\.\s*\w+)$/;

/** A string naming a member that reaches a constructor: read as a member, it is the database constructor. */
const ESCAPE_WORD = /^(?:constructor|__proto__|__class__|prototype|getPrototypeOf|setPrototypeOf|construct)$/;
/** Calls that read a member named by an argument: `getattr(mem, "__class__")`, `Reflect.get(mem, k)`. */
const ATTR_CALL = /\b(?:getattr|setattr|delattr|attrgetter|__getattribute__|__getattr__|Reflect\s*\.\s*(?:get|getOwnPropertyDescriptor|has)|Object\s*\.\s*getOwnPropertyDescriptors?)\s*\(/;

/**
 * Why code that loads a database module reaches a constructor the gate cannot tie to a checked open,
 * or null (astra-7 B4). A constructor read off an instance is the database constructor itself
 * (`const C = mem.constructor`, `const {constructor: C} = mem`, `Object.getPrototypeOf(mem).constructor`,
 * Python `mem.__class__` and `type(mem)(…)`), and it opens any path, statics included
 * (`mem.constructor.open(p)`): every spelling of `constructor` or a prototype in code is refused, and
 * so is `Reflect.construct`. Comments are not code, and a string naming one (`"constructor"`, folded
 * `'constr'+'uctor'` included) is data until it is used as a member: refused as an object or
 * destructuring key, or in code that also reads a member computed at run time (`mem[k]`, `mem[("…")]`)
 * or by name (`getattr`, `Reflect.get`) — `mem["constructor"]` is already `.constructor` (dotAccess).
 * A string in a log line or a comment is allowed (astra-8 S1). Every `new` must name a database export
 * in `dbNames` (whose target the caller checks), a builtin that opens no file, or a class or function
 * this code declares whose `extends` is one of those; anything else (`new C(…)`, `new (expr)(…)`,
 * `new x[k](…)`) is refused, fail-closed. A constructor's static opens (`D.open(p)`, `D.deserialize(b)`)
 * on a bound name are refused too.
 */
export function dbConstructorEscape(facts: CodeFacts, dbNames: readonly string[]): string | null {
	const code = facts.uncommented;
	for (const m of facts.folded.matchAll(LITERAL)) {
		if (code[m.index!] !== m[0][0] || !ESCAPE_WORD.test(unescape(m[1] ?? m[2] ?? m[3] ?? ""))) continue;
		const end = m.index! + m[0].length;
		const key = /[{,][\s([]*$/.test(code.slice(0, m.index!)) && /^[\s)\]]*:/.test(code.slice(end));
		const use = key ? "as an object or destructuring key" : firstComputedMember(code, facts.folded) !== null || ATTR_CALL.test(code) ? "in code that reads a member by a computed name" : null;
		if (use) return `naming \`${m[0].slice(1, -1)}\` in a string ${use} (a member reached by it is the database constructor)`;
	}
	const reach =
		/(?:\?\.|\.)\s*(?:constructor|__proto__|__class__|prototype)(?![\w$])|(?<![\w$.])constructor\s*(?=[:,}=]|\s*$)|\b(?:getPrototypeOf|setPrototypeOf|Reflect\s*\.\s*construct)\b|(?<![\w$.])type\s*\([^()]*\)\s*\(/.exec(code);
	if (reach) return `reaching a constructor through \`${reach[0].trim()}\` (a constructor read off a database instance is the database constructor, and it opens any path)`;
	const names = dbNames.map((n) => n.replace(/\$/g, "\\$")).join("|");
	const statics = new RegExp(String.raw`(?<![\w$.])(?:${names})\s*\??\.\s*(?:open|deserialize)(?![\w$])`).exec(code);
	if (statics) return `opening through the constructor's static \`${statics[0].trim()}\` (the gate does not check its target)`;
	const declared = new Set<string>();
	const safe = (name: string) => SAFE_BUILTIN.test(name) || declared.has(name);
	for (const m of code.matchAll(/\bclass(?:\s+([\w$]+))?(?:\s*<[^{]*?>)?\s*(?:extends\s+([^{]*?))?(?:\s+implements\s+[^{]*?)?\s*\{|\bfunction\s*\*?\s*([\w$]+)\s*\(/g)) {
		const base = m[2]?.trim();
		if (base !== undefined && !safe(base)) return `a class extending \`${base.slice(0, 60)}\`, which the gate cannot resolve to a class that opens no database`;
		const name = m[1] ?? m[3];
		if (name) declared.add(name);
	}
	for (const m of code.matchAll(/(?<![\w$.])new(?![\w$])(?!\s*\.\s*target\b)\s*/g)) {
		const at = m.index! + m[0].length;
		const chain = /^[\w$]+(?:\s*\??\.\s*[\w$]+)*/.exec(code.slice(at))?.[0];
		const next = chain === undefined ? code[at] : code.slice(at + chain.length).trimStart()[0];
		if (chain !== undefined && next !== "[") {
			const parts = chain.split(/\s*\??\.\s*/);
			if (parts.length === 1 && (safe(chain) || dbNames.includes(chain))) continue;
			if (parts.length > 1 && (SAFE_BUILTIN.test(chain) || dbNames.includes(parts.at(-1)!))) continue;
		}
		return `constructing with \`new ${facts.folded.slice(at, at + 40).split(/[(;\n]/)[0]!.trim()}\`, a constructor the gate cannot resolve to a checked database open or a class that opens no database`;
	}
	return null;
}

/**
 * File-writing APIs (JS/TS and Python spellings), and SQLite handles. `openSync` is not here: the
 * open family gets the typed read-only proof in r10 writingOpen (astra-5 R5-S3). A `Bun.file()`
 * handle is judged there too, where its every use is read (R5-B3); the direct `.write`/`.writer`
 * spelling stays here.
 */
export const WRITE_API =
	/\bBun\s*\.\s*(?:write|file\s*\([^)]*\)\s*\.\s*write\w*)\b|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync|link|linkSync)\s*\(|(?<![\w.])open\s*\([^)]*,\s*["'][^"']*[wax+]|\bbun:sqlite\b|\bbetter-sqlite3\b|\bnode:sqlite\b|\bsqlite3\b|\bapsw\b|\bnew\s+Database\s*\(|\bshutil\s*\.|\bos\s*\.\s*(?:remove|unlink|rename|replace)\b|\bPath\s*\([^)]*\)\s*\.\s*(?:write_\w+|unlink|rename|replace|touch)\b/;

/**
 * Browser mutations called on any receiver (`t.click(`, `page.fill("#q", …)`, `(await x).press(`).
 * `fill` counts only with a selector string first, so `Array(3).fill(0)` is not a browser write.
 */
export const BROWSER_WRITE_CALL =
	/\.\s*(click|dblclick|press|pressSequentially|uncheck|setChecked|selectOption|setInputFiles|dragTo|dragAndDrop|submit|tap|typeText|uploadFile|handleDialog|fill(?=\s*\(\s*["'`]))\s*\(/;
