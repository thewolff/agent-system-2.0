// Timing tools share the existing linter, never a second timing policy. Parsing uses only Bun's
// built-in syntax parser and the restricted source-range AST below: no operator package cache.
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { counts, lex, parseBaseline, ratchet, scan, shrinkOnly, type ScanResult } from "./timing-lint";

export const BASELINE_PATH = "surface/test/timing-baseline.tsv";
export const hashSource = (source: string): string => createHash("sha256").update(source).digest("hex");
const fail = (where: string, message: string): never => { throw new Error(`${where}: ${message}; source unchanged, inspect evidence and prepare a new request`); };
const object = (value: unknown, where: string): Record<string, unknown> => {
 if (!value || typeof value !== "object" || Array.isArray(value)) fail(where, "expected an object");
 return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
 for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unknown field ${key}`);
}
function text(value: unknown, where: string): string {
 if (typeof value !== "string" || !value.trim()) fail(where, "expected nonempty string");
 return value as string;
}
export function repoPath(value: unknown): string {
 const path = text(value, "repo path");
 if (isAbsolute(path) || path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith(".")) || /[\x00-\x1f\x7f:]/.test(path)) fail(path, "expected canonical non-hidden repo-relative path");
 return path;
}
export type AuditRow = { file: string; class: string; batch: string; round2Correction: boolean; mechanismSource: string; reviewSource: string | null };
export type AuditMap = { base?: string; files: AuditRow[] };
export function parseAuditMap(value: unknown): AuditMap {
 const root = object(value, "audit map");
 if (!Array.isArray(root.files)) fail("audit map", "files must be an array");
 const seen = new Set<string>();
 const files = root.files.map((value, index): AuditRow => {
  const row = object(value, `audit row ${index}`);
  const file = repoPath(row.file);
  if (!file.endsWith(".test.ts")) fail(file, "audit member is not a .test.ts file");
  if (seen.has(file)) fail(file, "duplicate audit member");
  seen.add(file);
  const classification = text(row.class, file);
  if (!["clean", "cpu-load-dependent", "timer-dependent", "timing-under-test"].includes(classification)) fail(file, `unknown audit class ${classification}`);
  if (typeof row.round2Correction !== "boolean") fail(file, "round2Correction must be boolean");
  const reviewSource = row.reviewSource === null ? null : text(row.reviewSource, `${file} reviewSource`);
  if (row.round2Correction && reviewSource === null) fail(file, "corrected taxonomy needs reviewSource");
  return { file, class: classification, batch: text(row.batch, file), round2Correction: row.round2Correction, mechanismSource: text(row.mechanismSource, file), reviewSource };
 });
 return { base: root.base === undefined ? undefined : text(root.base, "audit base"), files };
}
export function reconcileMembership(current: string[], historical: string[], main: string[]) {
 const difference = (a: string[], b: string[]) => { const other = new Set(b); return a.filter((p) => !other.has(p)).sort(); };
 return { addedSinceAudit: difference(current, historical), removedSinceAudit: difference(historical, current), addedSinceMain: difference(current, main), removedSinceMain: difference(main, current) };
}
export function inspectSources(sources: Map<string, string>, audit: AuditMap) {
 const historical = new Map(audit.files.map((row) => [row.file, row]));
 const historicalClassTotals: Record<string, number> = {};
 const classTotals: Record<string, number> = {};
 for (const row of audit.files) {
  historicalClassTotals[row.class] = (historicalClassTotals[row.class] ?? 0) + 1;
  if (sources.has(row.file)) classTotals[row.class] = (classTotals[row.class] ?? 0) + 1;
 }
 const files = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([file, source]) => {
  const result = scan(source);
  const row = historical.get(file);
  const code = lex(source).code;
  const lines = source.split("\n");
  let cursor = 0, line = 1;
  const subprocessObservations = [...code.matchAll(/\b(?:Bun\s*\.\s*spawn(?:Sync)?|spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\s*\(/g)].map((match) => {
   for (; cursor < match.index; cursor++) if (code[cursor] === "\n") line++;
   return { line, anchor: lines[line - 1]!.trim(), kind: "lexical-call-site-only", limitation: "Not execution counts or subprocess detection; aliases, wrappers and child internals need boundary evidence." };
  });
  return { file, hash: hashSource(source), scan: result, subprocessObservations,
   audit: row ? { ...row, anchor: `heading \`${file}\`` } : null,
   mechanismStatus: !row ? "unclassified-current-file: review-required" : row.class === "timer-dependent" && result.findings.length === 0 ? "historical-timer-with-no-current-lint-finding: review-required" : row.class === "clean" && result.findings.length > 0 ? "historical-clean-with-current-lint-findings: review-required" : "historical-mechanism-not-runtime-revalidated",
  };
 });
 return { files, classTotals, historicalClassTotals, unclassifiedFiles: files.filter((row) => row.audit === null).map((row) => row.file), correctedRows: audit.files.filter((row) => row.round2Correction).length,
  corrections: [
   { anchor: "surface/test/intake-queue.test.ts", implementation: "surface/extensions/workload.ts", status: "historical review correction, not a new runtime claim" },
   { anchor: "repoWithOrigin", staticGitCalls: 8, status: "historical review correction, not measured spawn cost" },
   { anchor: "plugins/i-have-audhd session_start", deadlineMs: 10000, status: "historical review correction, not runtime proof" },
  ],
 };
}
export function baselineRows(source: string, where: string) {
 const result = parseBaseline(source);
 if (!source.split("\n").includes("file\tpattern\tcount")) result.errors.push("missing file<TAB>pattern<TAB>count header");
 for (const row of result.rows) {
  repoPath(row.file);
  if (!Number.isSafeInteger(row.count)) result.errors.push(`line ${row.line}: count is not a safe integer`);
 }
 if (result.errors.length) fail(where, result.errors.join("; "));
 return result.rows;
}
/** Exact scan output, checked against BOTH the current file and the pinned base; no clamp-to-ceiling. */
export function exactBaseline(sources: Map<string, string>, current: string, base: string) {
 const before = baselineRows(current, BASELINE_PATH);
 const original = baselineRows(base, "pinned base baseline");
 const currentGrowth = shrinkOnly(original, before);
 if (currentGrowth.length) fail(BASELINE_PATH, currentGrowth.join("; "));
 const findings = new Map<string, ScanResult["findings"]>();
 for (const [file, source] of sources) {
  const result = scan(source);
  if (result.problems.length) fail(file, result.problems.map((p) => `${p.line}: ${p.problem}`).join("; "));
  findings.set(file, result.findings);
 }
 const found = counts(findings);
 const header = current.split("\n").filter((line) => line.startsWith("#") || line === "file\tpattern\tcount");
 const body = [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, count]) => `${key}\t${count}`);
 const candidate = `${[...header, ...body].join("\n")}\n`;
 const after = baselineRows(candidate, "generated baseline");
 const errors = [...shrinkOnly(before, after).map((error) => `against current baseline: ${error}`), ...shrinkOnly(original, after).map((error) => `against pinned base baseline: ${error}`), ...ratchet(found, after, (key) => key)];
 if (errors.length) fail(BASELINE_PATH, errors.join("; "));
 const sourceHashes = Object.fromEntries([...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, source]) => [file, hashSource(source)]));
 return { text: candidate, oldHash: hashSource(current), newHash: hashSource(candidate), sourceHashes, scanHash: hashSource(JSON.stringify(sourceHashes)), changes: ratchet(found, before, (key) => key), diff: sourceDiff(BASELINE_PATH, current, candidate) };
}
export function sourceDiff(file: string, before: string, after: string): string {
 if (before === after) return "";
 const a = before.split("\n"), b = after.split("\n");
 if (a[a.length - 1] === "") a.pop();
 if (b[b.length - 1] === "") b.pop();
 return [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((line) => `-${line}`), ...(before.endsWith("\n") ? [] : ["\\ No newline at end of file"]), ...b.map((line) => `+${line}`), ...(after.endsWith("\n") ? [] : ["\\ No newline at end of file"])].join("\n");
}

// A deliberately small AST: a literal for-of statement enclosing exactly one imported Bun test
// declaration, or a standalone await-sleep statement with an immediately following await witness.
// Bun parses the WHOLE source first. Unsupported syntax is refused, not recovered or guessed.
type Range = { start: number; end: number };
type CaseMapping = { before: string; after: string };
type Transform = Range & { replacement: string; cases: CaseMapping[]; evidence?: unknown };
function syntax(source: string, file: string): void {
 try { new Bun.Transpiler({ loader: "ts" }).transformSync(source); }
 catch (error) { fail(file, `Bun syntax admission failed: ${String(error)}`); }
}
function closing(code: string, start: number, left: string, right: string): number {
 if (code[start] !== left) return -1;
 let depth = 0;
 for (let i = start; i < code.length; i++) {
  if (code[i] === left) depth++;
  else if (code[i] === right && --depth === 0) return i;
 }
 return -1;
}
function range(edit: Record<string, unknown>, source: string, where: string): Range {
 if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || (edit.start as number) < 0 || (edit.end as number) <= (edit.start as number) || (edit.end as number) > source.length) fail(where, "invalid UTF-16 source range");
 return { start: edit.start as number, end: edit.end as number };
}
// The selected call name resolves to Bun's binding only when the module holds no other binding of
// it anywhere: exactly one unaliased `import { name } from "bun:test"`, and every other code
// occurrence is a call `name(` or member read `name.x` of it, or a member name of another object.
// Parameters (ordinary, arrow, destructured, rest, default), catch clauses, patterns, declarations,
// labels, keys and escape-spelled identifiers are unprovable positions and refuse the request.
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
function previousToken(code: string, at: number): { token: string; start: number } {
 let end = at;
 while (end > 0 && /\s/.test(code[end - 1]!)) end--;
 let start = end;
 while (start > 0 && IDENTIFIER_PART.test(code[start - 1]!)) start--;
 return start < end ? { token: code.slice(start, end), start } : { token: code[end - 1] ?? "", start: end - 1 };
}
function bunTestImport(source: string, name: string): void {
 const code = lex(source).code;
 const line = (at: number) => source.slice(0, at).split("\n").length;
 const escape = code.indexOf("\\");
 if (escape >= 0) fail(name, `escape-spelled identifier at line ${line(escape)} can alias the ${name} binding; binding to bun:test is unproven`);
 const specifiers: Range[] = [];
 let proven = 0;
 for (const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']bun:test["']/g)) {
  if (!code.startsWith("import", match.index)) continue;
  const list = { start: match.index + match[0].indexOf("{"), end: match.index + match[0].indexOf("}") + 1 };
  if (code.slice(list.start, list.end) !== source.slice(list.start, list.end)) fail(name, `bun:test import at line ${line(match.index)} holds comments or literals among its specifiers; binding unproven`);
  for (const part of match[1]!.split(",").map((value) => value.trim())) {
   if (part === name) proven++;
   else if (new RegExp(`(?<![\\p{ID_Continue}$])${name}(?![\\p{ID_Continue}$])`, "u").test(part)) fail(name, `bun:test specifier "${part}" at line ${line(match.index)} aliases or retypes ${name}; only an unaliased named import is mechanical`);
  }
  specifiers.push(list);
 }
 if (proven !== 1) fail(name, proven ? `${name} is imported from bun:test ${proven} times` : "transform requires an unaliased named bun:test import");
 for (const use of code.matchAll(new RegExp(`(?<![\\p{ID_Continue}$#\\u200c\\u200d])${name}(?![\\p{ID_Continue}$\\u200c\\u200d])`, "gu"))) {
  const at = use.index;
  if (specifiers.some((list) => at > list.start && at < list.end)) continue;
  const previous = previousToken(code, at);
  if (previous.token === "." && code[previous.start - 1] !== ".") continue;
  const declared = previous.token === "function" || previous.token === "class" || (previous.token === "*" && previousToken(code, previous.start).token === "function");
  if (!declared && previous.token !== "." && /^\s*[(.](?!\.)/u.test(code.slice(at + name.length, at + name.length + 64))) continue;
  fail(name, `${name} at line ${line(at)} is a parameter, pattern, declaration, rest element or other non-call position that can shadow the bun:test import; binding unproven, rewrite by hand`);
 }
}
function loopTransform(source: string, edit: Record<string, unknown>, where: string): Transform {
 keys(edit, ["kind", "start", "end"], where);
 const span = range(edit, source, where);
 const part = source.slice(span.start, span.end);
 if (!lex(source).code.startsWith("for", span.start)) fail(where, "range is not a code for-of statement");
 const head = /^for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*(\[[\s\S]*?\])\s*\)\s*\{\s*/.exec(part);
 if (!head) fail(where, "unsupported for-of header: require const binding and a JSON string array");
 const binding = head[1]!;
 let values: unknown;
 try { values = JSON.parse(head[2]!); } catch (error) { fail(where, `unsupported literal cases: ${String(error)}`); }
 if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string" || !v || /[%\x00-\x1f\x7f\u2028\u2029]/.test(v))) fail(where, "literal cases must be nonempty single-line strings without format directives");
 const strings = values as string[];
 if (new Set(strings).size !== strings.length) fail(where, "duplicate case identities");
 const call = /^(test|it)\s*\(\s*`([^`\\]*)`\s*,\s*(async\s+)?\(\s*\)\s*=>\s*\{/.exec(part.slice(head[0].length));
 if (!call) fail(where, "unsupported loop body: require exactly one test(template, [async] () => block), no modifiers, timeout or callback parameters");
 bunTestImport(source, call[1]!);
 const title = call[2]!;
 const marker = `\${${binding}}`;
 if (!title.includes(marker) || title.split(marker).length !== 2 || title.replace(marker, "").includes("${") || /[%\r\n]/.test(title)) fail(where, "title must contain exactly one direct binding interpolation and no format directives");
 const bodyStart = head[0].length + call[0].length - 1;
 const code = lex(part).code;
 const bodyEnd = closing(code, bodyStart, "{", "}");
 if (bodyEnd < 0 || !/^\s*\)\s*;?\s*}\s*$/.test(part.slice(bodyEnd + 1))) fail(where, "unsupported loop tail: extra statements, modifiers or timeout changes are forbidden");
 const body = part.slice(bodyStart, bodyEnd + 1);
 const bodyCode = lex(body).code;
 const escaped = binding.replaceAll("$", "\\$");
 if (/\b(?:arguments|this|eval|function|class|var|yield|return|break|continue)\b|=>/.test(bodyCode) || new RegExp(`\\b(?:const|let|catch)\\s*\\(?\\s*${escaped}\\b|(?<![\\w$])${escaped}\\s*(?:[+*/%&|^?-]?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${escaped}\\b`).test(bodyCode)) fail(where, "unsupported callback mutation/control-flow/closure or binding shadowing");
 if (/(?<![=!<>])=(?!=)|\+\+|--|[+\-*/%&|^?]=|[<>]{2,3}=/.test(bodyCode)) fail(where, "unsupported callback assignment or mutation; only read-only assertion bodies are mechanical");
 if (bodyCode.includes("...") || /\b(?:for|while|do|switch|try)\b/.test(bodyCode)) fail(where, "unsupported callback control flow or spread");
 // Destructuring writes, indirect eval and reflective name use are not mechanically proven.
 if (/[\]}]\s*=/.test(bodyCode) || /\b(?:globalThis|Reflect)\b/.test(bodyCode)) fail(where, "unsupported indirect mutation or reflection");
 const scopes = enclosingScopes(source, span.start, span.end);
 provenScopeChain(source, span.start, scopes, call[1]!, where);
 const scope = scopes.map((item) => item.title).join(" > ");
 const names = strings.map((value) => [scope, title.replace(marker, value)].filter(Boolean).join(" > "));
 return { ...span, replacement: `${call[1]}.each(${head[2]})(${JSON.stringify(title.replace(marker, "%s"))}, ${call[3] ? "async " : ""}(${binding}) => ${body});`, cases: names.map((name) => ({ before: name, after: name })) };
}
type Scope = { kind: string; title: string; open: number; start: number; end: number };
/** Admitted static describe/test/it("title", [async] () => { ... }) bodies enclosing [start, end), outermost first. */
function enclosingScopes(source: string, start: number, end: number): Scope[] {
 const code = lex(source).code;
 if (/\bdescribe\s*\.\s*each\b/.test(code)) fail("case mapping", "parameterized suite identities require a semantic hand edit");
 const scopes: Scope[] = [];
 for (const match of code.matchAll(/(?<![\w$.])(test|it|describe)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g)) {
  const open = code.indexOf("(", match.index);
  const close = closing(code, open, "(", ")");
  if (match.index >= start || close < end) continue;
  const call = /^(test|it|describe)\s*\(\s*("[^"\\\r\n]*"|'[^'\\\r\n]*')\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{/.exec(source.slice(match.index));
  if (!call) fail("case mapping", "unsupported enclosing test/suite name, modifier or callback");
  const bodyStart = match.index + call[0].length - 1;
  const bodyEnd = closing(code, bodyStart, "{", "}");
  if (bodyStart < start && bodyEnd >= end) {
   bunTestImport(source, call[1]!);
   scopes.push({ kind: call[1]!, title: call[2]!.slice(1, -1), open, start: bodyStart, end: bodyEnd });
  }
 }
 return scopes.sort((a, b) => a.start - b.start);
}
function enclosingCase(source: string, start: number, end: number): CaseMapping {
 const scopes = enclosingScopes(source, start, end);
 if (!scopes.some((scope) => scope.kind === "test" || scope.kind === "it")) fail("remove-sleep", "unsupported enclosing case: require imported Bun test with a static title and no-argument callback");
 const name = scopes.map((scope) => scope.title).join(" > ");
 return { before: name, after: name };
}
// A loop is rewritten only at module level or directly inside admitted suite/case callback bodies.
// Any other enclosing bracket (function or arrow body, parameter list, block, call argument, object,
// template interpolation) is a closure or scope boundary whose binding of the call name, run count
// and suite prefix are not proven here, so the request is refused rather than resolved.
function provenScopeChain(source: string, at: number, scopes: Scope[], name: string, where: string): void {
 const code = lex(source).code;
 const admitted = new Set(scopes.flatMap((scope) => [scope.open, scope.start]));
 const open: number[] = [];
 for (let i = 0; i < at; i++) {
  const c = code[i];
  if (c === "(" || c === "[" || c === "{") open.push(i);
  else if ((c === ")" || c === "]" || c === "}") && open.pop() === undefined) fail(where, `lexed brackets unbalanced at offset ${i} before the selected loop; scope chain unproven, report the lexer input`);
 }
 const boundary = open.find((index) => !admitted.has(index));
 if (boundary === undefined) return;
 const line = source.slice(0, boundary).split("\n").length;
 fail(where, `selected loop sits inside a closure or scope boundary opened at line ${line} (${JSON.stringify(source.split("\n")[line - 1]!.trim())}); the ${name} binding there is unproven, only module level or describe/test/it("title", () => { ... }) bodies are mechanical`);
}
function sleepTransform(source: string, edit: Record<string, unknown>, where: string): Transform {
 keys(edit, ["kind", "start", "end", "evidence"], where);
 const span = range(edit, source, where);
 const witness = object(edit.evidence, `${where} evidence`);
 keys(witness, ["kind", "event", "receipt", "reason"], `${where} evidence`);
 if (witness.kind !== "awaited-event") fail(where, "unsupported sleep evidence kind");
 const event = text(witness.event, `${where} awaited event`);
 if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(event)) fail(where, "awaited event must be an existing property expression, not a supplied call or readiness guess");
 const receipt = text(witness.receipt, `${where} evidence receipt`);
 if (!receipt.includes("#")) fail(where, "evidence receipt must carry a stable review anchor");
 const reason = text(witness.reason, `${where} evidence reason`);
 if (reason.length < 20) fail(where, "evidence reason must explain why no contract or assertion depends on this delay");
 if (source.includes("timing-under-test")) fail(where, "timing-under-test source is not eligible for sleep deletion");
 const selected = source.slice(span.start, span.end);
 const code = lex(source).code;
 if (!/^await\s+Bun\.sleep\(\s*\d[\d_]*\s*\);$/.test(selected) || !code.startsWith("await", span.start) || !/[{;}]\s*$/.test(code.slice(0, span.start))) fail(where, "unsupported removal syntax: require standalone await Bun.sleep(number); statement");
 const next = /^\s*await\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;/.exec(code.slice(span.end));
 if (next?.[1] !== event) fail(where, `already-present next awaited event does not match ${event}`);
 if (/\b(?:Date|performance)\s*\.|\b(?:setTimeout|setInterval|spyOn|mock)\s*\(|\bBun\s*\.\s*(?:nanoseconds|sleep)\s*=|\b(?:const|let|var|function|class)\s+Bun\b/.test(code)) fail(where, "sleep source contains a clock contract or overridden timer; semantic hand edit required");
 return { ...span, replacement: "", cases: [enclosingCase(source, span.start, span.end)], evidence: { kind: witness.kind, event, receipt, reason } };
}
export function prepareRewrite(source: string, value: unknown) {
 const request = object(value, "rewrite request");
 keys(request, ["version", "file", "oldHash", "edits"], "rewrite request");
 if (request.version !== 1) fail("rewrite request", "version must be 1");
 const file = repoPath(request.file);
 if (!file.endsWith(".test.ts")) fail(file, "only .test.ts sources can be rewritten");
 const oldHash = hashSource(source);
 if (request.oldHash !== oldHash) fail(file, `oldHash mismatch: requested ${String(request.oldHash)}, observed ${oldHash}`);
 syntax(source, file);
 if (!Array.isArray(request.edits) || !request.edits.length) fail(file, "edits must be a nonempty array");
 const edits = request.edits.map((value, index) => {
  const edit = object(value, `${file} edit ${index}`);
  const where = `${file} edit ${index} hash ${oldHash}`;
  if (edit.kind === "loop-to-each") return loopTransform(source, edit, where);
  if (edit.kind === "remove-sleep") return sleepTransform(source, edit, where);
  return fail(where, `unsupported transformation ${String(edit.kind)}; existing DI/readiness/clock changes require a semantic hand edit`);
 }).sort((a, b) => a.start - b.start);
 for (let i = 1; i < edits.length; i++) if (edits[i]!.start < edits[i - 1]!.end) fail(file, "overlapping source ranges");
 let output = source;
 for (const edit of [...edits].reverse()) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
 syntax(output, file);
 const before = scan(source), after = scan(output);
 if (after.problems.length) fail(file, `rewrite creates/retains invalid opt-out: ${JSON.stringify(after.problems)}`);
 const oldCounts = counts(new Map([[file, before.findings]])), newCounts = counts(new Map([[file, after.findings]]));
 for (const [key, n] of newCounts) if (n > (oldCounts.get(key) ?? 0)) fail(file, `rewrite adds timing finding ${key}`);
 return { file, oldHash, newHash: hashSource(output), source: output, cases: edits.flatMap((edit) => edit.cases), evidence: edits.flatMap((edit) => edit.evidence ? [edit.evidence] : []), diff: sourceDiff(file, source, output) };
}

/** Resolve the actual target under the actual root; reject all symlink path components. */
export function ownedFile(rootInput: string, fileInput: string): string {
 const root = realpathSync(rootInput), file = repoPath(fileInput), target = resolve(root, file);
 const rel = relative(root, target);
 if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(target, "target escapes repository root");
 let current = root;
 for (const component of file.split("/")) {
  current = resolve(current, component);
  if (lstatSync(current).isSymbolicLink()) fail(current, "symlink targets are not writable inputs");
 }
 if (!lstatSync(target).isFile() || realpathSync(target) !== target) fail(target, "target must be an owned regular file");
 return target;
}
function withDescriptor<T>(fd: number, where: string, action: (fd: number) => T): T {
 let result: T | undefined;
 let failed = false;
 let original: unknown;
 try { result = action(fd); }
 catch (error) { failed = true; original = error; }
 try { closeSync(fd); }
 catch (cleanup) {
  if (failed) throw new AggregateError([original, cleanup], `${where}: operation and descriptor cleanup failed; inspect both errors`);
  throw cleanup;
 }
 if (failed) throw original;
 return result as T;
}
/** One guarded file per invocation; a same-directory atomic replacement retains file permissions. */
export function applyGuarded(root: string, file: string, oldHash: string, replacement: string): void {
 const target = ownedFile(root, file);
 const mode = withDescriptor(openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW), target, (fd) => {
  if (hashSource(readFileSync(fd, "utf8")) !== oldHash) fail(target, "oldHash changed before apply");
  return fstatSync(fd).mode;
 });
 const temporary = resolve(dirname(target), `.timing-rewrite-${crypto.randomUUID()}`);
 let pending = true;
 try {
  withDescriptor(openSync(temporary, "wx", mode), temporary, (output) => {
   writeFileSync(output, replacement, "utf8");
   fchmodSync(output, mode & 0o777);
   fsyncSync(output);
  });
  if (ownedFile(root, file) !== target || hashSource(readFileSync(target, "utf8")) !== oldHash) fail(target, "oldHash changed during apply");
  renameSync(temporary, target);
  pending = false;
 } catch (error) {
  if (pending) {
   try { unlinkSync(temporary); }
   catch (cleanup) {
    if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanup], `${target}: apply and temporary-file cleanup failed; inspect both errors`);
   }
  }
  throw error;
 }
}

export function gitOutput(root: string, argv: string[]): string {
 const result = Bun.spawnSync(["git", "-C", root, ...argv], { stdout: "pipe", stderr: "pipe" });
 if (result.exitCode !== 0) throw new Error(`git -C ${root} ${argv.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim()}; inspect repository/ref before retrying`);
 return result.stdout.toString();
}
export function trackedTests(root: string, ref?: string, includeUntracked = false): string[] {
 const paths = gitOutput(root, ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : includeUntracked ? ["ls-files", "--cached", "--others", "--exclude-standard", "-z"] : ["ls-files", "-z"]);
 const tests = paths.split("\0").filter((path) => path.endsWith(".test.ts") && !path.split("/").some((p) => p.startsWith(".") || p === "node_modules"));
 return [...new Set(tests)].sort();
}
export function readSources(root: string, files: string[]): Map<string, string> {
 return new Map(files.map((file) => [file, readFileSync(ownedFile(root, file), "utf8")]));
}
export function parseOptions(argv: string[], allowed: string[]): Record<string, string | true> {
 const out: Record<string, string | true> = {};
 for (let i = 0; i < argv.length; i++) {
  const key = argv[i]!;
  if (!allowed.includes(key) || Object.hasOwn(out, key)) fail("arguments", `unknown or duplicate option ${key}`);
  if (["--apply", "--dry-run", "--help"].includes(key)) out[key] = true;
  else {
   const value = argv[++i];
   if (!value || value.startsWith("--")) fail("arguments", `missing value for ${key}`);
   out[key] = value;
  }
 }
 if (out["--apply"] && out["--dry-run"]) fail("arguments", "choose --apply or --dry-run, not both");
 return out;
}
