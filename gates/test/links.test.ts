import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileUrl, internalHandles, linkMarkdown, linkedPaths, linkTerminal } from "../src/links";

const root = mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(), "links-"));
mkdirSync(join(root, "My Docs"));
for (const name of ["README.md", "__init__.py", "My Docs/plan.md"]) writeFileSync(join(root, name), "one\ntwo\nthree");
const opts = { cwd: root, home: root, repo: { host: "github.com", slug: "o/r" } };
const md = (visible: string, path: string) => `[${visible.replace(/[\\`*_\[\]<>~&$]/g,c=>c === "[" ? "&#91;" : c === "]" ? "&#93;" : `\\${c}`)}](${fileUrl(path)})`;
// Follow the installed executable, as the surface's consumer paint regression does.
const HOST_MARKDOWN = (() => {
 const omp=Bun.which("omp");
 if(!omp) return null;
 let dir=dirname(realpathSync(omp));
 while(basename(dir) !== "@oh-my-pi") {
  const up=dirname(dir);
  if(up === dir) return null;
  dir=up;
 }
 const file=join(dir,"pi-tui/src/components/markdown.ts");
 return existsSync(file) ? file : null;
})();

describe("T1 openable text", () => {
 test("existing absolute, home, relative, bare and one-segment paths", () => {
  for (const text of [join(root, "README.md"), "~/README.md", "README.md", "./README.md"]) expect(linkMarkdown(text, opts)).toBe(md(join(root, "README.md"), join(root, "README.md")));
  expect(linkMarkdown("/tmp", opts)).toBe(md("/tmp", "/tmp"));
 });
 test("standalone slash separators stay prose in Markdown and terminal output", () => {
  for(const text of ["/", "left / right", "$150 / 12h", "`/`"]) {
   expect(linkMarkdown(text,opts)).toBe(text);
   expect(linkTerminal(text,opts)).toBe(text);
  }
 });
 test("whole existing filenames retain Markdown-special characters", () => {
  const dir=join(root,"_x_","*y*","tick`mark","[z]");
  mkdirSync(dir,{recursive:true});
  const p=join(dir,"PLAN.md");
  writeFileSync(p,"plan");
  const linked=linkMarkdown(`Open ${p}.`,opts);
  expect(linked).toContain("/\\_x\\_/\\*y\\*/tick\\`mark/&#91;z&#93;/PLAN.md]");
  expect(linked).toContain(`](${fileUrl(p)}).`);
  expect(linkMarkdown(linked,opts)).toBe(linked);
  expect(linkTerminal(linked,opts)).toContain(p);
  expect(linkedPaths(linkMarkdown(`${p}:3`,opts))).toEqual([{path:p,line:"3"}]);
  const entityPath=join(dir,"literal&#91;.md");
  writeFileSync(entityPath,"plan");
  expect(linkTerminal(linkMarkdown(entityPath,opts),opts)).toBe(linkTerminal(entityPath,opts));
 });
 test.skipIf(HOST_MARKDOWN === null)("installed host paints every special path character at width 40", async () => {
  // Runtime-selected host install; a static repo import would not exercise OMP's renderer.
  const { Markdown }=await import(HOST_MARKDOWN!);
  const theme=Object.fromEntries(["heading","link","linkUrl","code","codeBlock","codeBlockBorder","quote","quoteBorder","hr","listBullet","bold","italic","strikethrough","underline"].map(k=>[k,(s:string)=>s]));
  const dir=join(root,"paint","_x_","*y*","tick`mark","[z]");
  mkdirSync(dir,{recursive:true});
  const p=join(dir,"PLAN.md");
  writeFileSync(p,"plan");
  const rows:string[]=new Markdown(linkMarkdown(p,opts),0,0,theme).render(40);
  expect(rows.every(r=>Bun.stringWidth(r) <= 40)).toBe(true);
  const shown=rows.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g,"").replace(/\s+/g,"");
  expect(shown).toContain(p);
 });
 test("space runs, delimited missing paths, suffixes, escaping and URL encoding", () => {
  const p = join(root, "My Docs/plan.md");
  expect(linkMarkdown(p, opts)).toBe(md(p, p));
  expect(linkMarkdown("My Docs/plan.md", opts)).toBe(md(p, p));
  expect(linkMarkdown("`My Docs/plan.md`", opts)).toBe(md(p, p));
  expect(linkMarkdown(`\`${p}\``, opts)).toBe(md(p, p));
  expect(linkMarkdown(`${p}:3-5`, opts)).toBe(md(`${p}:3-5`, p));
  expect(linkMarkdown(`${p}:3:7`, opts)).toBe(md(`${p}:3:7`, p));
  expect(linkMarkdown(join(root, "__init__.py"), opts)).toContain("/\\_\\_init\\_\\_.py]");
  expect(fileUrl(join(root, "a (#?%).md"))).toEndWith("a%20%28%23%3F%25%29.md");
  const missing = join(root, "missing.md");
  expect(linkMarkdown(`${missing} and should I approve?`, opts)).toBe(`${md(missing, missing)} and should I approve?`);
  const spaced = join(root, "My Docs/missing file.md");
  expect(linkMarkdown(`\`${spaced}\``, opts)).toBe(md(spaced, spaced));
  expect(linkMarkdown("/v1/feeds/legacy /login", opts)).toBe("/v1/feeds/legacy /login");
 });
 test("punctuation, exemptions and idempotency", () => {
  const p = join(root, "README.md");
  for (const s of [`\`bun test ${p}\``, `bash ~/x.sh`, `\`\`\`review-findings\n${p}\n\`\`\``, `~~~\n${p}\n~~~`, `<!-- ${p} -->`, md(p,p), "<https://x.y/z>"]) expect(linkMarkdown(s, opts)).toBe(s);
  expect(linkMarkdown("https://x.y/z.", opts)).toBe("<https://x.y/z>.");
  expect(linkMarkdown("https://x.y/a(b)).", opts)).toBe("<https://x.y/a(b)>).");
  const s = linkMarkdown(`${p}:2 and https://x.y/z.`, opts);
  expect(linkMarkdown(s, opts)).toBe(s);
  expect(linkTerminal(linkTerminal(p, opts), opts)).toBe(linkTerminal(p, opts));
  expect(linkTerminal(md(p, p), opts)).toBe(linkTerminal(p, opts));
 });
 test("scheme tokens keep interior delimiters after prose boundaries", () => {
  expect(linkMarkdown("Read (https://x.y/a(b)).",opts)).toBe("Read (<https://x.y/a(b)>).");
  const query="pr://o/r?state=open&author=x&label=y";
  const url="https://github.com/o/r/pulls?q=is%3Apr+is%3Aopen+author%3Ax+label%3Ay";
  expect(linkMarkdown(`Read "${query}".`,opts)).toBe(`Read "[pr://o/r?state=open\\&author=x\\&label=y](${url})".`);
  expect(linkTerminal(query,opts)).toBe(`\x1b]8;;${url}\x07${query}\x1b]8;;\x07`);
 });
 test.each([
  ["pr://12", "https://github.com/o/r/pull/12"], ["issue://7", "https://github.com/o/r/issues/7"],
  ["pr://o/r/12", "https://github.com/o/r/pull/12"], ["pr://ghe.co/o/r/3", "https://ghe.co/o/r/pull/3"],
  ...["diff", "diff/all", "diff/2"].map(s => [`pr://12/${s}`, "https://github.com/o/r/pull/12/files"]),
  ["pr://", "https://github.com/o/r/pulls"], ["issue://o/r", "https://github.com/o/r/issues"],
  ["pr://o/r?state=open&author=x&label=y", "https://github.com/o/r/pulls?q=is%3Apr+is%3Aopen+author%3Ax+label%3Ay"],
 ])("routes %s", (handle, url) => expect(linkMarkdown(handle!, opts)).toBe(`[${handle!.replace(/&/g, "\\&")}](${url})`));
 test("injected handles, terminal links and receipt decoding", () => {
  const p = join(root,"My Docs/plan.md");
  expect(linkMarkdown("local://plan", { ...opts, handles: new Map([["local://plan",p]]) })).toBe(md("local://plan",p));
  expect(internalHandles("local://a `artifact://b`\n```\nlocal://c\n```\nrule://r")).toEqual(["local://a","artifact://b"]);
  expect(linkTerminal(p,opts)).toBe(`\x1b]8;;${fileUrl(p)}\x07${p}\x1b]8;;\x07 (\x1b]8;;${fileUrl(p)}\x07${fileUrl(p)}\x1b]8;;\x07)`);
  expect(linkedPaths(md(`${p}:3`,p))).toEqual([{path:p,line:"3"}]);
  expect(linkedPaths(`${p}:3`)).toEqual([{path:p,line:"3"}]);
 });
});
