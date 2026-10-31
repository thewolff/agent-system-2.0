import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGuarded, exactBaseline, hashSource, inspectSources, ownedFile, parseAuditMap, prepareRewrite, reconcileMembership } from "../src/timing-automation";

const baseline = (rows = "") => `# retained evidence\nfile\tpattern\tcount\n${rows}`;
const source = 'import { test, expect } from "bun:test";\nfor (const value of ["alpha", "beta"]) {\n test(`accepts ${value}`, async () => {\n  expect(value.length).toBeGreaterThan(0);\n });\n}\n';
const loop = { kind: "loop-to-each", start: source.indexOf("for ("), end: source.lastIndexOf("}") + 1 };
const request = (text: string, edits: unknown[]) => ({ version: 1, file: "surface/test/example.test.ts", oldHash: hashSource(text), edits });

describe("audit membership and exact baseline", () => {
 test("separates historical membership drift from drift against pinned main", () => {
  expect(reconcileMembership(["a.test.ts", "new.test.ts"], ["a.test.ts", "gone.test.ts"], ["main.test.ts", "a.test.ts"])).toEqual({ addedSinceAudit: ["new.test.ts"], removedSinceAudit: ["gone.test.ts"], addedSinceMain: ["new.test.ts"], removedSinceMain: ["main.test.ts"] });
 });
 test("applies corrected classification rows without claiming runtime verification", () => {
  const audit = parseAuditMap({ base: "historic", files: [{ file: "a.test.ts", class: "timer-dependent", batch: "events", round2Correction: true, mechanismSource: "AUDIT.md — heading `a.test.ts`", reviewSource: "REVIEW.md — Round 2" }] });
  const report = inspectSources(new Map([["a.test.ts", 'test("done", () => expect(1).toBe(1));']]), audit);
  expect(report.classTotals).toEqual({ "timer-dependent": 1 });
  expect(report.correctedRows).toBe(1);
  expect(report.files[0]!.mechanismStatus).toBe("historical-timer-with-no-current-lint-finding: review-required");
  expect(report.files[0]!.audit!.anchor).toBe("heading `a.test.ts`");
 });
 test("rejects ambiguous or malformed audit membership", () => {
  expect(() => parseAuditMap({ files: [{ file: "../escape.test.ts" }] })).toThrow();
  const row = { file: "a.test.ts", class: "clean", batch: "retain-subject", round2Correction: false, mechanismSource: "heading a", reviewSource: null };
  expect(() => parseAuditMap({ files: [row, row] })).toThrow("duplicate");
 });
 test("uses real scan counts and emits only exact decreases, retaining comments", () => {
  const sources = new Map([["a.test.ts", "await Bun.sleep(20);"]]);
  const old = baseline("a.test.ts\tsleep\t2\nb.test.ts\ttimer\t1\n");
  const result = exactBaseline(sources, old, old);
  expect(result.text).toBe(baseline("a.test.ts\tsleep\t1\n"));
  expect(result.changes).toHaveLength(2);
  expect(result.sourceHashes).toEqual({ "a.test.ts": hashSource("await Bun.sleep(20);") });
  const changed = exactBaseline(new Map([["a.test.ts", "await Bun.sleep(20); // different input"]]), old, old);
  expect(changed.text).toBe(result.text);
  expect(changed.scanHash).not.toBe(result.scanHash);
 });
 test.each([
  ["addition", baseline(), baseline(), new Map([["a.test.ts", "await Bun.sleep(20);"]])],
  ["raise", baseline("a.test.ts\tsleep\t1\n"), baseline("a.test.ts\tsleep\t1\n"), new Map([["a.test.ts", "await Bun.sleep(1); await Bun.sleep(2);"]])],
  ["move", baseline("old.test.ts\tsleep\t1\n"), baseline("new.test.ts\tsleep\t1\n"), new Map([["new.test.ts", "await Bun.sleep(1);"]])],
 ])("refuses baseline %s", (_name, base, head, sources) => {
  expect(() => exactBaseline(sources as Map<string, string>, head as string, base as string)).toThrow();
 });
 test("refuses malformed baseline and invalid opt-outs instead of shrinking around them", () => {
  expect(() => exactBaseline(new Map(), "", baseline())).toThrow("header");
  expect(() => exactBaseline(new Map([["a.test.ts", "// timing-under-test: bogus\nawait Bun.sleep(1);"]]), baseline("a.test.ts\tsleep\t1\n"), baseline("a.test.ts\tsleep\t1\n"))).toThrow("opt-out");
 });
 test("reports subprocess call-site observations separately from timing findings", () => {
  const report = inspectSources(new Map([["a.test.ts", 'const p = Bun.spawn(["child"]);\nawait p.exited;']]), { files: [] });
  expect(report.files[0]!.scan.findings).toEqual([]);
  expect(report.files[0]!.subprocessObservations[0]!.anchor).toBe('const p = Bun.spawn(["child"]);');
 });
});

describe("hash-guarded restricted rewrites", () => {
 test("maps literal loop cases to identical rendered test.each identities and preserves assertions", () => {
  const result = prepareRewrite(source, request(source, [loop]));
  expect(result.source).toContain('test.each(["alpha", "beta"])("accepts %s", async (value) => {');
  expect(result.source).toContain("expect(value.length).toBeGreaterThan(0);");
  expect(result.cases).toEqual([{ before: "accepts alpha", after: "accepts alpha" }, { before: "accepts beta", after: "accepts beta" }]);
  expect(result.diff).toContain("-for (const value");
  expect(result.oldHash).toBe(hashSource(source));
  expect(result.newHash).toBe(hashSource(result.source));
 });
 test("keeps static suite prefixes in semantic case identities", () => {
  const text = source.replace('{ test, expect }', '{ test, expect, describe }').replace("for (const", 'describe("suite", () => {\nfor (const') + "\n});";
  const start = text.indexOf("for (");
  const loopEnd = text.indexOf("\n}", start) + 2;
  const result = prepareRewrite(text, request(text, [{ ...loop, start, end: loopEnd }]));
  expect(result.cases).toEqual([{ before: "suite > accepts alpha", after: "suite > accepts alpha" }, { before: "suite > accepts beta", after: "suite > accepts beta" }]);
 });
 test("refuses stale source before preparing any edit", () => {
  expect(() => prepareRewrite(`${source}\n`, request(source, [loop]))).toThrow("oldHash");
 });
 test.each([
  source.replace("test(`", "test.skip(`"),
  source.replace(" });", " }, 50);"),
  source.replace("for (const", "for (let"),
  source.replace('["alpha", "beta"]', 'getCases()'),
  source.replace(" });", " }); sideEffect();"),
  source.replace("async ()", "async (done)"),
  source.replace("accepts ${value}", "accepts ${value.length}"),
  source.replace("alpha", "a%s"),
  source.replace("expect(value.length)", "value = 'other'; expect(value.length)"),
  source.replace("expect(value.length)", "const read = () => value; expect(value.length)"),
  source.replace("expect(value.length)", "if (value) return; expect(value.length)"),
  source.replace("expect(value.length)", "const { value } = other; expect(value.length)"),
  source.replace("expect(value.length)", "value ||= 'other'; expect(value.length)"),
  source.replace("expect(value.length)", "(value) = 'other'; expect(value.length)"),
  source.replace("expect(value.length)", "value <<= 1; expect(value.length)"),
 ])("rejects unsupported loop shape without producing a partial rewrite", (text) => {
  expect(() => prepareRewrite(text, request(text, [{ ...loop, start: text.indexOf("for ("), end: text.lastIndexOf("}") + 1 }]))).toThrow();
 });
 test("refuses overlapping, arbitrary replacement and unknown fields", () => {
  expect(() => prepareRewrite(source, request(source, [loop, loop]))).toThrow("overlap");
  expect(() => prepareRewrite(source, request(source, [{ kind: "replace", start: 0, end: source.length, text: "" }]))).toThrow();
  expect(() => prepareRewrite(source, { ...request(source, [loop]), allowSkips: true })).toThrow("unknown");
 });
 test("removes only a caller-evidenced sleep immediately before the same awaited event", () => {
  const text = 'import { test, expect } from "bun:test";\ntest("exit", async () => {\n await Bun.sleep(20);\n await proc.exited;\n expect(proc.exitCode).toBe(0);\n});';
  const start = text.indexOf("await Bun.sleep");
  const end = text.indexOf(";", start) + 1;
  const edit = { kind: "remove-sleep", start, end, evidence: { kind: "awaited-event", event: "proc.exited", receipt: "REVIEW.md#exit-barrier", reason: "Readiness is established solely by awaited process exit; no elapsed-time assertion or timer contract depends on this delay." } };
  const result = prepareRewrite(text, request(text, [edit]));
  expect(result.source).not.toContain("Bun.sleep");
  expect(result.source).toContain("await proc.exited;");
  expect(result.source).toContain("expect(proc.exitCode).toBe(0);");
  expect(result.cases).toEqual([{ before: "exit", after: "exit" }]);
  expect(() => prepareRewrite(text, request(text, [{ ...edit, evidence: { ...edit.evidence, event: "other.exited" } }]))).toThrow("awaited event");
  expect(() => prepareRewrite(text, request(text, [{ ...edit, evidence: undefined }]))).toThrow("evidence");
 });
 test("will not remove a timing-subject delay or guess an injected dependency", () => {
  const text = '// timing-under-test: delay boundary (fake clock: clock)\ntest("delay", async () => { clock.tick(); await Bun.sleep(20); await proc.exited; });';
  const start = text.indexOf("await Bun.sleep");
  expect(() => prepareRewrite(text, request(text, [{ kind: "remove-sleep", start, end: text.indexOf(";", start) + 1, evidence: { kind: "awaited-event", event: "proc.exited", receipt: "REVIEW.md#delay", reason: "A review witness cannot waive timing-under-test coverage." } }]))).toThrow("timing-under-test");
  expect(() => prepareRewrite(source, request(source, [{ kind: "inject-clock" }]))).toThrow("unsupported");
 });
 test.each([
  'if (ready)\n await Bun.sleep(20); await proc.exited;',
  'await Bun.sleep(20); sideEffect(); await proc.exited;',
  'await Bun.sleep(20); await other.exited;',
  'await Bun.sleep(20); await proc.exited; expect(Date.now()).toBe(20);',
 ])("refuses a removal witness that does not establish the supported boundary", (body) => {
  const text = `import { test, expect } from "bun:test";\ntest("exit", async () => { ${body} });`;
  const start = text.indexOf("await Bun.sleep");
  expect(() => prepareRewrite(text, request(text, [{ kind: "remove-sleep", start, end: text.indexOf(";", start) + 1, evidence: { kind: "awaited-event", event: "proc.exited", receipt: "REVIEW.md#exit", reason: "A claimed witness cannot authorize unsupported source shape." } }]))).toThrow();
 });
 test("refuses imports forged inside comments or strings and ranges inside literals", () => {
  const forged = source.replace('import { test, expect } from "bun:test";', '/* import { test, expect } from "bun:test"; */');
  expect(() => prepareRewrite(forged, request(forged, [{ ...loop, start: forged.indexOf("for ("), end: forged.lastIndexOf("}") + 1 }]))).toThrow("import");
  const literal = `const text = ${JSON.stringify(source)};`;
  expect(() => prepareRewrite(literal, request(literal, [{ ...loop, start: literal.indexOf("for ("), end: literal.lastIndexOf("}") + 1 }]))).toThrow();
 });
 describe("imported test binding proof", () => {
  const loopText = source.slice(source.indexOf("for ("), source.lastIndexOf("}") + 1);
  const header = 'import { test, expect, describe } from "bun:test";\n';
  const rewrite = (text: string) => {
   const start = text.indexOf("for (");
   return prepareRewrite(text, request(text, [{ kind: "loop-to-each", start, end: start + loopText.length }]));
  };
  test.each([
   ["ordinary parameter", "function register(test) {\n", "\n}\nregister(helper);"],
   ["arrow parameter", "const register = (test) => {\n", "\n};"],
   ["bare arrow parameter", "const register = test => {\n", "\n};"],
   ["destructured arrow parameter", "const register = ({ test }) => {\n", "\n};"],
   ["renamed destructured parameter", "function register({ helper: test }) {\n", "\n}"],
   ["array parameter with default", "function register([test] = [helper]) {\n", "\n}"],
   ["rest parameter", "function register(...test) {\n", "\n}"],
   ["catch parameter", "try { setup(); } catch (test) {\n", "\n}"],
   ["suite-level destructured declaration", 'describe("suite", () => {\nconst { test } = helpers;\n', "\n});"],
   ["var pattern hoisted out of a nested block", 'describe("suite", () => {\nif (helpers) { var [test] = helpers.list; }\n', "\n});"],
   ["hoisted generator declaration", 'describe("suite", () => {\n', "\nfunction * test() {}\n});"],
   ["sibling helper parameter elsewhere in the module", "function other(test) { return test; }\n", ""],
  ])("refuses a loop whose test is shadowed by a %s", (_name, before, after) => {
   const text = `${header}${before}${loopText}${after}\n`;
   expect(() => rewrite(text)).toThrow("can shadow the bun:test import");
  });
  test("refuses an escape-spelled binding that aliases test", () => {
   const text = `${header}describe("suite", () => {\nconst t\\u0065st = helper;\n${loopText}\n});\n`;
   expect(() => rewrite(text)).toThrow("escape-spelled identifier");
  });
  test.each([
   ["arrow closure", "const register = () => {\n", "\n};\nregister();"],
   ["function closure", "function register() {\n", "\n}\nregister();"],
   ["conditional block", "if (enabled) {\n", "\n}"],
   ["plain block", "{\n", "\n}"],
   ["call argument callback", "wrap(() => {\n", "\n});"],
   ["callback nested inside a suite", 'describe("suite", () => {\n[1].forEach(() => {\n', "\n});\n});"],
  ])("refuses an unshadowed loop behind a %s boundary", (_name, before, after) => {
   const text = `${header}${before}${loopText}${after}\n`;
   expect(() => rewrite(text)).toThrow("closure or scope boundary");
  });
  test("still rewrites the imported it alias inside a suite and ignores member names", () => {
   const text = `import { it, expect, describe } from "bun:test";\nconst label = other.it ?? other?.it;\ndescribe("suite", () => {\n${loopText.replace("test(`", "it(`")}\n});\n`;
   const start = text.indexOf("for (");
   const result = prepareRewrite(text, request(text, [{ kind: "loop-to-each", start, end: text.indexOf("\n}", start) + 2 }]));
   expect(result.source).toContain('it.each(["alpha", "beta"])("accepts %s", async (value) => {');
   expect(result.cases).toEqual([{ before: "suite > accepts alpha", after: "suite > accepts alpha" }, { before: "suite > accepts beta", after: "suite > accepts beta" }]);
  });
  test("refuses an aliased bun:test specifier that binds the call name", () => {
   const aliased = source.replace("{ test, expect }", "{ it as test, expect }");
   expect(() => rewrite(aliased)).toThrow("aliases or retypes test");
  });
 });
});

describe("guarded filesystem apply", () => {
 test("writes exactly the admitted source, retains permissions and refuses stale reuse", () => {
  const root = mkdtempSync(join(tmpdir(), "timing-automation-"));
  try {
   mkdirSync(join(root, "surface/test"), { recursive: true });
   const file = "surface/test/example.test.ts";
   const path = join(root, file);
   writeFileSync(path, source);
   chmodSync(path, 0o640);
   const prepared = prepareRewrite(source, request(source, [loop]));
   applyGuarded(root, file, prepared.oldHash, prepared.source);
   expect(readFileSync(path, "utf8")).toBe(prepared.source);
   expect(statSync(path).mode & 0o777).toBe(0o640);
   expect(() => applyGuarded(root, file, prepared.oldHash, source)).toThrow("oldHash");
   expect(readFileSync(path, "utf8")).toBe(prepared.source);
   expect(readdirSync(join(root, "surface/test"))).toEqual(["example.test.ts"]);
  } catch (error) { throw new Error(`timing apply fixture retained at ${root}`, { cause: error }); }
  rmSync(root, { recursive: true });
 });
 test("rejects traversals, symlink files and symlink directories without modifying targets", () => {
  const root = mkdtempSync(join(tmpdir(), "timing-automation-"));
  try {
   mkdirSync(join(root, "real"));
   const path = join(root, "real", "example.test.ts");
   writeFileSync(path, source);
   symlinkSync("real", join(root, "linked"));
   symlinkSync("real/example.test.ts", join(root, "example.test.ts"));
   expect(() => ownedFile(root, "../example.test.ts")).toThrow();
   expect(() => ownedFile(root, "linked/example.test.ts")).toThrow("symlink");
   expect(() => applyGuarded(root, "example.test.ts", hashSource(source), "")).toThrow("symlink");
   expect(readFileSync(path, "utf8")).toBe(source);
  } catch (error) { throw new Error(`timing path fixture retained at ${root}`, { cause: error }); }
  rmSync(root, { recursive: true });
 });
});
