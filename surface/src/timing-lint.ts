// The incidental-timing check (.ai/decision-log/2026-10-28--0840--plumb--tests-depend-on-timing-only-when-timing-is-under-test.md):
// a test may depend on timing only when timing is the thing under test. This module finds the places a test file
// depends on the machine's speed, statically, and never runs the file. surface/test/timing-lint.test.ts runs it over
// every test file in the repository against the committed ratchet (surface/test/timing-baseline.tsv).
//
// The source is lexed first: comments and string, template and regex literal bodies are blanked to spaces (line breaks
// kept), so a pattern never matches inside a string or a comment, and line numbers stay exact. A template's `${…}`
// expressions stay code. Patterns then run on the blanked code. Each one, precisely:
//
//   sleep         `Bun.sleep(` or `Bun.sleepSync(`; or a call to a function named sleep, delay, pause or wait whose first
//                 argument starts with a digit (`await sleep(50)`).
//   timer         a call to the global `setTimeout(` or `setInterval(` (bare, or on `globalThis.`), which covers
//                 `await new Promise((r) => setTimeout(r, 50))`, a watchdog `setTimeout(() => p.kill(), 30_000)` and a
//                 scheduled event. A method call on another object (`ctx.setTimeout(`) is not the global timer, and a
//                 declaration (`setTimeout(cb, ms): unknown`, a call followed by `:` or `{`) is not a call.
//   race          `Promise.race(` whose arguments name a timer: setTimeout/setInterval, Bun.sleep, a sleep-named call, or
//                 an identifier containing timeout, deadline, timer, sleep or delay. A race of two real events is not one.
//   clock-assert  a wall-clock read (`Date.now()`, `performance.now()`, `Bun.nanoseconds()`) on a line that holds
//                 `expect(` and a relational matcher (toBeLessThan, toBeLessThanOrEqual, toBeGreaterThan,
//                 toBeGreaterThanOrEqual, toBeWithin, toBeCloseTo), unless the read is a fixture timestamp (below).
//   clock-elapsed a wall-clock read minus a timestamp: `Date.now() - t0`.
//   clock-deadline a timestamp minus a wall-clock read (`deadline - Date.now()`), or a wall-clock read on either side
//                 of `<`, `<=`, `>` or `>=` (`while (Date.now() < end)`).
//   A fixture timestamp is a wall-clock read plus or minus a duration and nothing else (`Date.now() - 8 * 86_400_000`,
//   `Date.now() + LEASE_MS + 1000`): it places a fixture hours away from now and does not measure the machine. An
//   operand is a duration when it has no lowercase letter (digits, ALL_CAPS names, operators), when it multiplies or
//   divides at its top level (`days * DAY_MS`), or when it is one name ending in Ms, MS, _ms, Millis, Sec or Offset
//   (`offsetMs`) or is exactly ms, millis, sec, seconds or offset; any other operand is a timestamp.
//   test-timeout  an explicit timeout below Bun's 5000 ms default: the last of three or more arguments to a test()/it()
//                 call when it is a number literal or `{ timeout: N }`, or `setDefaultTimeout(N)` / `jest.setTimeout(N)`,
//                 with 0 < N < 5000. A larger timeout is a hang guard; a smaller one is a race with the machine.
// A wall-clock read takes one pattern, in the order clock-assert, clock-elapsed, clock-deadline.
//
// Not detected: a deadline passed to a polling helper as a plain number (`until(cond, 20_000)`), `new Date()` reads,
// and timing inside a child process the test spawns. The rule still covers them; the check does not.
//
// The opt-out, for a test whose subject is timing: a line comment
//     // timing-under-test: <what timing behaviour is under test> (fake clock: <name>)
// <what…> must hold a letter. <name> is the fake or injected clock the test drives (an identifier path such as `clock`,
// `setSystemTime`, `vi.useFakeTimers`), never a real clock (Date, Date.now, performance.now, Bun.nanoseconds, Bun.sleep,
// setTimeout, setInterval). The comment covers its own line when it trails code; on a line by itself it covers the next
// non-blank line, and when that line opens a test(), it() or describe() call, the whole call. The clock is "in use" when
// <name> appears as code (not in a comment or string) in the covered call, else in the innermost test()/it() call around
// the covered line, else anywhere in the file. That is a name check, not proof that the clock is fake: the comment names
// the clock, and review judges it. A malformed opt-out, a real clock named, a clock not found in use, and an opt-out
// that covers no finding are each a problem the check reports.

export const PATTERNS = ["sleep", "timer", "race", "clock-assert", "clock-elapsed", "clock-deadline", "test-timeout"] as const;
export type Pattern = (typeof PATTERNS)[number];

export type Finding = { line: number; pattern: Pattern; text: string };
export type OptOutProblem = { line: number; problem: string };
export type ScanResult = { findings: Finding[]; problems: OptOutProblem[]; optedOut: number };

/** Bun's default per-test timeout (https://bun.com/docs/test/runtime-behavior, "Test Timeouts"). */
export const DEFAULT_TIMEOUT_MS = 5000;

const REAL_CLOCKS: Record<string, true> = {
	Date: true, "Date.now": true, performance: true, "performance.now": true, "Bun.nanoseconds": true, "Bun.sleep": true,
	"Bun.sleepSync": true, setTimeout: true, setInterval: true, "globalThis.setTimeout": true, "globalThis.setInterval": true,
};
const OPT_OUT_MARK = /\btiming-under-test\b/;
const OPT_OUT = /^\s*timing-under-test:\s*(.*?)\s*\(fake clock:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)\s*$/;

type Comment = { line: number; text: string; ownLine: boolean };
type Lexed = { code: string; comments: Comment[]; lineStarts: number[] };

const REGEX_PREV_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "await", "yield", "else", "do"]);

/** Blanks comments and literal bodies to spaces, keeping every line break, and collects the comments. */
export function lex(src: string): Lexed {
	const out = src.split("");
	const comments: Comment[] = [];
	const lineStarts = [0];
	for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
	const blank = (a: number, b: number) => {
		for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
	};
	// One frame per open template literal: the brace depth of its innermost `${`.
	const templates: number[] = [];
	let braces = 0;
	let i = 0;
	const prevSignificant = (): string => {
		let k = i - 1;
		while (k >= 0 && /\s/.test(out[k]!)) k--;
		if (k < 0) return "";
		if (/[\w$]/.test(out[k]!)) {
			let s = k;
			while (s > 0 && /[\w$]/.test(out[s - 1]!)) s--;
			return out.slice(s, k + 1).join("");
		}
		return out[k]!;
	};
	const templateBody = () => {
		// i is just past a backtick or a `}` that closes `${`; blank until the closing backtick or the next `${`.
		const start = i;
		while (i < src.length) {
			const c = src[i]!;
			if (c === "\\") { i += 2; continue; }
			if (c === "`") { blank(start, i); i++; return; }
			if (c === "$" && src[i + 1] === "{") { blank(start, i); templates.push(braces); braces++; i += 2; return; }
			i++;
		}
		blank(start, i);
	};
	while (i < src.length) {
		const c = src[i]!;
		const n = src[i + 1];
		if (c === "/" && n === "/") {
			const end = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
			const line = lineAt(lineStarts, i);
			comments.push({ line, text: src.slice(i + 2, end), ownLine: src.slice(lineStarts[line - 1]!, i).trim() === "" });
			blank(i, end);
			i = end;
			continue;
		}
		if (c === "/" && n === "*") {
			const close = src.indexOf("*/", i + 2);
			const end = close === -1 ? src.length : close + 2;
			blank(i, end);
			i = end;
			continue;
		}
		if (c === "'" || c === '"') {
			const start = i++;
			while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
			blank(start + 1, i);
			i++;
			continue;
		}
		if (c === "`") {
			i++;
			templateBody();
			continue;
		}
		if (c === "{") { braces++; i++; continue; }
		if (c === "}") {
			braces--;
			if (templates.length > 0 && templates[templates.length - 1] === braces) {
				templates.pop();
				i++;
				templateBody();
				continue;
			}
			i++;
			continue;
		}
		if (c === "/") {
			const p = prevSignificant();
			const isRegex = p === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(p) || REGEX_PREV_KEYWORDS.has(p);
			if (isRegex) {
				const start = i++;
				let inClass = false;
				while (i < src.length && src[i] !== "\n") {
					const r = src[i]!;
					if (r === "\\") { i += 2; continue; }
					if (r === "[") inClass = true;
					else if (r === "]") inClass = false;
					else if (r === "/" && !inClass) break;
					i++;
				}
				blank(start + 1, i);
				i++;
				continue;
			}
		}
		i++;
	}
	return { code: out.join(""), comments, lineStarts };
}

function lineAt(lineStarts: number[], offset: number): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid]! <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

/** The offset of the bracket that closes the one at `open`, on blanked code; -1 when unclosed. */
function closeOf(code: string, open: number): number {
	let depth = 0;
	for (let k = open; k < code.length; k++) {
		const c = code[k]!;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) return k;
		}
	}
	return -1;
}

/** Top-level comma-separated arguments of the call whose parentheses are at `open`..`close`. */
function args(code: string, open: number, close: number): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = open + 1;
	for (let k = open + 1; k < close; k++) {
		const c = code[k]!;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			out.push(code.slice(start, k).trim());
			start = k + 1;
		}
	}
	const last = code.slice(start, close).trim();
	if (last !== "" || out.length > 0) out.push(last);
	return out.filter((a, idx, all) => !(a === "" && idx === all.length - 1));
}

/** A call at `open` that is followed by `:` or `{` is a declaration (a method signature or body), not a call. */
function isDeclaration(code: string, open: number): boolean {
	const close = closeOf(code, open);
	if (close === -1) return false;
	let k = close + 1;
	while (k < code.length && /\s/.test(code[k]!)) k++;
	return code[k] === ":" || code[k] === "{";
}

/** True when the name at `at` is a member of something else: the previous non-space character is `.` (`ctx . setTimeout`). */
function isMember(code: string, at: number): boolean {
	let k = at - 1;
	while (k >= 0 && (code[k] === " " || code[k] === "\t" || code[k] === "\n")) k--;
	return code[k] === ".";
}

export type Span = { start: number; end: number; open: number; close: number; kind: "test" | "describe" };

/** Every test()/it()/describe() call, with the span of its final argument list (after `.each(…)`, `.if(…)` and the like). */
export function testCalls(code: string): Span[] {
	const out: Span[] = [];
	const re = /(?<![\w$])(test|it|describe)\b/g;
	for (let m = re.exec(code); m; m = re.exec(code)) {
		if (isMember(code, m.index)) continue;
		let k = m.index + m[0].length;
		let open = -1;
		let close = -1;
		for (;;) {
			while (k < code.length && /\s/.test(code[k]!)) k++;
			const dot = /^\.\s*[A-Za-z_$][\w$]*/.exec(code.slice(k, k + 64));
			if (dot) { k += dot[0].length; continue; }
			if (code[k] === "(") {
				const c = closeOf(code, k);
				if (c === -1) break;
				open = k;
				close = c;
				k = c + 1;
				continue;
			}
			break;
		}
		if (open === -1 || isDeclaration(code, open)) continue;
		out.push({ start: m.index, end: close, open, close, kind: m[1] === "describe" ? "describe" : "test" });
	}
	return out;
}

const CLOCK = /(?<![\w$])(?:Date\s*\.\s*now|performance\s*\.\s*now|Bun\s*\.\s*nanoseconds)\s*\(\s*\)/g;
const SLEEP_CALL = /(?<![\w$.])(?:sleep|delay|pause|wait)\s*\(/;
const RELATIONAL_MATCHER = /\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toBeWithin|toBeCloseTo)\s*\(/;
/** A duration operand (see the header): constant-only, scaled at its top level, or one name ending in a unit. */
function isDuration(operand: string): boolean {
	const s = operand.trim();
	if (s === "") return false;
	if (!/[a-z]/.test(s)) return true;
	if (/^(?:[A-Za-z_$][\w$]*(?:Ms|MS|_ms|Millis|Sec|Offset)|ms|millis|sec|seconds|offset)$/.test(s)) return true;
	let depth = 0;
	for (const c of s) {
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (depth === 0 && (c === "*" || c === "/")) return true;
	}
	return false;
}

/** The operand after a binary operator at `from`, up to the next top-level delimiter. */
function operandAfter(code: string, from: number): string {
	let depth = 0;
	let k = from;
	for (; k < code.length; k++) {
		const c = code[k]!;
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && (c === "," || c === ";" || c === "\n" || c === "<" || c === ">" || c === "=" || c === "?" || c === "&" || c === "|")) break;
	}
	return code.slice(from, k);
}

/** The operand before a binary operator ending at `to` (exclusive), back to the previous top-level delimiter. */
function operandBefore(code: string, to: number): string {
	let depth = 0;
	let k = to - 1;
	for (; k >= 0; k--) {
		const c = code[k]!;
		if (c === ")" || c === "]" || c === "}") depth++;
		else if (c === "(" || c === "[" || c === "{") {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && (c === "," || c === ";" || c === "\n" || c === "<" || c === ">" || c === "=" || c === "?" || c === "&" || c === "|")) break;
	}
	return code.slice(k + 1, to);
}

type Site = { offset: number; pattern: Pattern };

function sites(code: string, lineStarts: number[], calls: Span[]): Site[] {
	const out: Site[] = [];
	for (const m of code.matchAll(/(?<![\w$])Bun\s*\.\s*sleep(?:Sync)?\s*\(/g)) if (!isMember(code, m.index)) out.push({ offset: m.index, pattern: "sleep" });
	for (const m of code.matchAll(/(?<![\w$])(?:sleep|delay|pause|wait)\s*\(\s*\d/g)) {
		if (!isMember(code, m.index) && !isDeclaration(code, code.indexOf("(", m.index))) out.push({ offset: m.index, pattern: "sleep" });
	}
	for (const m of code.matchAll(/(?<![\w$])(?:globalThis\s*\.\s*)?(?:setTimeout|setInterval)\s*\(/g)) {
		if (!isMember(code, m.index) && !isDeclaration(code, code.indexOf("(", m.index))) out.push({ offset: m.index, pattern: "timer" });
	}
	for (const m of code.matchAll(/(?<![\w$])Promise\s*\.\s*race\s*\(/g)) {
		if (isMember(code, m.index)) continue;
		const open = code.indexOf("(", m.index + 7);
		const close = closeOf(code, open);
		const inner = code.slice(open, close === -1 ? code.length : close);
		if (/Bun\s*\.\s*sleep|[\w$]*(?:[Tt]imeout|[Dd]eadline|[Tt]imer|[Ss]leep|[Dd]elay|setInterval)[\w$]*/.test(inner) || SLEEP_CALL.test(inner)) {
			out.push({ offset: m.index, pattern: "race" });
		}
	}
	for (const m of code.matchAll(CLOCK)) {
		const end = m.index + m[0].length;
		const before = /(?<![-=+])-\s*$/.exec(code.slice(Math.max(0, m.index - 32), m.index));
		const after = /^\s*([-+])(?![-+=])\s*/.exec(code.slice(end, end + 32));
		const operand = after ? operandAfter(code, end + after[0].length) : "";
		if (!before && after && isDuration(operand)) continue; // a fixture timestamp
		const l = lineAt(lineStarts, m.index);
		const line = code.slice(lineStarts[l - 1]!, lineStarts[l] ?? code.length);
		if (line.includes("expect(") && RELATIONAL_MATCHER.test(line)) {
			out.push({ offset: m.index, pattern: "clock-assert" });
			continue;
		}
		if (after?.[1] === "-") {
			out.push({ offset: m.index, pattern: "clock-elapsed" });
			continue;
		}
		if (before && !isDuration(operandBefore(code, m.index - before[0].length))) {
			out.push({ offset: m.index, pattern: "clock-deadline" });
			continue;
		}
		if (/^\s*(?:<=?|>=?)(?!=)/.test(code.slice(end, end + 8)) || /(?<![=>])(?:<=?|>=?)\s*$/.test(code.slice(Math.max(0, m.index - 8), m.index))) {
			out.push({ offset: m.index, pattern: "clock-deadline" });
		}
	}
	const small = (lit: string): boolean => {
		const n = Number(lit.replaceAll("_", ""));
		return n > 0 && n < DEFAULT_TIMEOUT_MS;
	};
	for (const call of calls) {
		if (call.kind !== "test") continue;
		const a = args(code, call.open, call.close);
		if (a.length < 3) continue;
		const last = a[a.length - 1]!;
		const lit = /^\d[\d_]*$/.test(last) ? last : /^\{[^{}]*\btimeout\s*:\s*(\d[\d_]*)/.exec(last)?.[1];
		if (lit !== undefined && small(lit)) out.push({ offset: call.start, pattern: "test-timeout" });
	}
	for (const m of code.matchAll(/(?<![\w$.])(?:setDefaultTimeout|jest\s*\.\s*setTimeout)\s*\(\s*(\d[\d_]*)\s*\)/g)) {
		if (small(m[1]!)) out.push({ offset: m.index, pattern: "test-timeout" });
	}
	return out.sort((x, y) => x.offset - y.offset);
}

type OptOut = { line: number; from: number; to: number; clock: string; scope: { start: number; end: number } | null; used: boolean };

/** Scans one test file's source. Pure: no file reads. */
export function scan(src: string): ScanResult {
	const { code, comments, lineStarts } = lex(src);
	const calls = testCalls(code);
	const problems: OptOutProblem[] = [];
	const optOuts: OptOut[] = [];
	const lineCount = lineStarts.length;
	const lineCode = (l: number) => code.slice(lineStarts[l - 1]!, lineStarts[l] ?? code.length);
	const tokenIn = (name: string, a: number, b: number) => {
		const esc = name.replace(/[.$]/g, (c) => `\\${c}`).replace(/\\\./g, "\\s*\\.\\s*");
		return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(code.slice(a, b));
	};
	for (const c of comments) {
		if (!OPT_OUT_MARK.test(c.text)) continue;
		const m = OPT_OUT.exec(c.text);
		if (!m) {
			problems.push({ line: c.line, problem: "timing-under-test opt-out is malformed; write `// timing-under-test: <what timing behaviour> (fake clock: <name>)`" });
			continue;
		}
		const [, reason, clock] = m as unknown as [string, string, string];
		if (!/[A-Za-z]/.test(reason)) {
			problems.push({ line: c.line, problem: "timing-under-test opt-out gives no reason; say what timing behaviour is under test" });
			continue;
		}
		if (Object.hasOwn(REAL_CLOCKS, clock)) {
			problems.push({ line: c.line, problem: `timing-under-test opt-out names the real clock ${clock}; name the fake or injected clock the test drives` });
			continue;
		}
		let target = c.line;
		if (c.ownLine) {
			target = c.line + 1;
			while (target <= lineCount && lineCode(target).trim() === "") target++;
		}
		const tFrom = lineStarts[target - 1] ?? code.length;
		const tTo = lineStarts[target] ?? code.length;
		const block = c.ownLine ? calls.find((s) => s.start >= tFrom && s.start < tTo) : undefined;
		const from = block ? lineStarts[lineAt(lineStarts, block.start) - 1]! : tFrom;
		const to = block ? block.end + 1 : tTo;
		const enclosing = calls
			.filter((s) => s.kind === "test" && s.start <= tFrom && s.end >= tFrom)
			.sort((x, y) => y.start - x.start)[0];
		const scope = block ? { start: block.start, end: block.end + 1 } : enclosing ? { start: enclosing.start, end: enclosing.end + 1 } : null;
		if (!tokenIn(clock, scope?.start ?? 0, scope?.end ?? code.length)) {
			problems.push({
				line: c.line,
				problem: `timing-under-test opt-out names fake clock ${clock}, which does not appear as code in ${scope ? "the covered test" : "this file"}; drive the timing with that clock, or remove the opt-out and wait on the real event`,
			});
			continue;
		}
		optOuts.push({ line: c.line, from, to, clock, scope, used: false });
	}
	const findings: Finding[] = [];
	let optedOut = 0;
	for (const s of sites(code, lineStarts, calls)) {
		const cover = optOuts.find((o) => s.offset >= o.from && s.offset < o.to);
		if (cover) {
			cover.used = true;
			optedOut++;
			continue;
		}
		const line = lineAt(lineStarts, s.offset);
		findings.push({ line, pattern: s.pattern, text: src.slice(lineStarts[line - 1]!, (lineStarts[line] ?? src.length + 1) - 1).trim() });
	}
	for (const o of optOuts) {
		if (!o.used) problems.push({ line: o.line, problem: "timing-under-test opt-out covers no timing finding; remove it" });
	}
	return { findings, problems, optedOut };
}

/** `file\tpattern` → count, from findings keyed by repo-relative path. */
export function counts(byFile: Map<string, Finding[]>): Map<string, number> {
	const out = new Map<string, number>();
	for (const [file, fs] of byFile) for (const f of fs) out.set(`${file}\t${f.pattern}`, (out.get(`${file}\t${f.pattern}`) ?? 0) + 1);
	return out;
}

export type BaselineRow = { file: string; pattern: string; count: number; line: number };

/** Parses the ratchet file: `#` comments, a `file\tpattern\tcount` header, then one row per file and pattern. */
export function parseBaseline(text: string): { rows: BaselineRow[]; errors: string[] } {
	const rows: BaselineRow[] = [];
	const errors: string[] = [];
	let header = false;
	text.split("\n").forEach((raw, idx) => {
		const line = idx + 1;
		if (raw === "" || raw.startsWith("#")) return;
		const cols = raw.split("\t");
		if (!header) {
			if (raw !== "file\tpattern\tcount") errors.push(`line ${line}: the header must be file<TAB>pattern<TAB>count`);
			header = true;
			return;
		}
		if (cols.length !== 3) return void errors.push(`line ${line}: expected 3 tab-separated columns, got ${cols.length}`);
		const [file, pattern, n] = cols as [string, string, string];
		if (!(PATTERNS as readonly string[]).includes(pattern)) errors.push(`line ${line}: unknown pattern ${pattern}`);
		if (!/^[1-9]\d*$/.test(n)) errors.push(`line ${line}: count ${n} is not a positive integer`);
		rows.push({ file, pattern, count: Number(n), line });
	});
	const keys = rows.map((r) => `${r.file}\t${r.pattern}`);
	const sorted = [...keys].sort();
	if (keys.some((k, i) => k !== sorted[i])) errors.push("rows are not sorted by file then pattern");
	if (new Set(keys).size !== keys.length) errors.push("a file and pattern appear on more than one row");
	return { rows, errors };
}

/**
 * The ratchet: every difference between what the scan found and what the baseline allows, worded with the fix.
 * Exact match is required, so a fixed offender fails until its row is lowered or deleted.
 */
export function ratchet(found: Map<string, number>, baseline: BaselineRow[], where: (key: string) => string): string[] {
	const out: string[] = [];
	const allowed = new Map(baseline.map((r) => [`${r.file}\t${r.pattern}`, r.count]));
	for (const [key, n] of [...found].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const [file, pattern] = key.split("\t");
		const a = allowed.get(key) ?? 0;
		if (n > a) out.push(`new incidental timing: ${file} has ${n} ${pattern} finding(s), the baseline allows ${a}: ${where(key)}. Wait on the real event or call the logic directly; if timing is the subject, drive it with a fake clock and add \`// timing-under-test: <what> (fake clock: <name>)\``);
	}
	for (const r of baseline) {
		const n = found.get(`${r.file}\t${r.pattern}`) ?? 0;
		if (n < r.count) out.push(`fixed incidental timing: ${r.file} has ${n} ${r.pattern} finding(s), the baseline still allows ${r.count}; ${n === 0 ? "delete" : `lower to ${n}`} its row in surface/test/timing-baseline.tsv`);
	}
	return out;
}
