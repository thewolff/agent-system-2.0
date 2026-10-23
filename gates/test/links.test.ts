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
 test("longest existing space paths survive long prose and formatting", () => {
  const dir=join(root,"space-prefix");
  mkdirSync(dir);
  for(const name of ["plan.md","plan.md extended notes.md","draft [v2] `notes`.md"]) writeFileSync(join(dir,name),"plan");
  const tail=" ordinary ledger words".repeat(800);
  for(const spelling of [dir,"~/space-prefix","./space-prefix","space-prefix"]) {
   for(const name of ["plan.md extended notes.md","draft [v2] `notes`.md"]) {
    const p=join(dir,name), source=`${spelling}/${name}:3`;
    const expected=`**${md(`${p}:3`,p)}**${tail}`;
    expect(linkMarkdown(`**${source}**${tail}`,opts)).toBe(expected);
    expect(linkMarkdown(expected,opts)).toBe(expected);
    expect(linkTerminal(`**${source}**${tail}`,opts)).toBe(`**${linkTerminal(`${p}:3`,opts)}**${tail}`);
    expect(linkedPaths(expected)).toEqual([{path:p,line:"3"}]);
   }
  }
 });
 for(const render of [linkMarkdown,linkTerminal]) {
  for(const shape of ["slash-free","path-leading","mixed"] as const) {
   test(`${render.name} avoids long-line freeze: ${shape}`, () => {
    const p=join(root,"README.md");
    const prose="ordinary ledger status words ".repeat(600);
    const text=shape === "slash-free" ? prose : shape === "path-leading" ? `${p} ${prose}` : `${prose.slice(0,prose.length/2)}${p} ${prose.slice(prose.length/2)}`;
    const expected=shape === "slash-free" ? text : shape === "path-leading" ? `${render(p,opts)} ${prose}` : `${prose.slice(0,prose.length/2)}${render(p,opts)} ${prose.slice(prose.length/2)}`;
    // Warm setup outside the measurement. Two seconds is a freeze guard, not a microbenchmark;
    // the ~17k single line amplifies the old repeated suffix scans well beyond timer noise.
    render("warm ordinary text",opts);
    const started=performance.now();
    const actual=render(text,opts);
    const elapsed=performance.now()-started;
    expect(actual).toBe(expected);
    expect(elapsed).toBeLessThan(2000);
   },120_000);
  }
  for(const shape of ["relative-tokens","test-run-json"] as const) {
   test(`${render.name} avoids multi-relative-path freeze: ${shape}`, () => {
    const relativeDir=shape === "relative-tokens" ? "test" : "classifier/test";
    const dir=join(root,relativeDir);
    mkdirSync(dir,{recursive:true});
    const linked=new Set([0,199,399]);
    for(const i of linked) writeFileSync(join(dir,`file${i}.test.ts`),"test");
    const entries=Array.from({length:400},(_,i)=>{
     const prefix=shape === "test-run-json" || i%3 === 0 ? "./" : i%3 === 1 ? `../${basename(root)}/` : "";
     const file=`${prefix}${relativeDir}/file${i}.test.ts`;
     const shown=linked.has(i) ? render(join(dir,`file${i}.test.ts`),opts) : file;
     return shape === "relative-tokens"
      ? {text:`${file} passed ok`,expected:`${shown} passed ok`}
      : {text:`{"file":"${file}","pass":1,"fail":0,"status":"passed ok"}`,expected:`{"file":"${shown}","pass":1,"fail":0,"status":"passed ok"}`};
    });
    const text=shape === "relative-tokens" ? entries.map(e=>e.text).join(" ") : `test-run: {"solo":[${entries.map(e=>e.text).join(",")}]}`;
    const expected=shape === "relative-tokens" ? entries.map(e=>e.expected).join(" ") : `test-run: {"solo":[${entries.map(e=>e.expected).join(",")}]}`;
    // Real first directories keep ./, ../ and cwd-relative starts eligible. Missing
    // relative files stay plain, while the three real files must still be linked.
    render("warm ordinary text",opts);
    const started=performance.now();
    const actual=render(text,opts);
    const elapsed=performance.now()-started;
    expect(actual).toBe(expected);
    // A generous freeze guard, not a throughput promise or a microbenchmark.
    expect(elapsed).toBeLessThan(2000);
   },120_000);
  }
  test(`${render.name} preserves longest spaced paths across slash boundaries`, () => {
   const dir=join(root,"slash prefix");
   mkdirSync(join(dir,"branch"),{recursive:true});
   const nested=join(dir,"branch extended","nested dir");
   mkdirSync(nested,{recursive:true});
   for(const name of ["plan.md","plan.md extended notes.md"]) writeFileSync(join(nested,name),"plan");
   const p=join(nested,"plan.md extended notes.md"),tail=" trailing ./not-present/file.ts passed ok";
   for(const prefix of [dir,"~/slash prefix","./slash prefix","slash prefix",`../${basename(root)}/slash prefix`]) {
    const source=`${prefix}/branch extended/nested dir/plan.md extended notes.md:3-5`;
    for(const wrapper of ["","**","`"]) {
     const kept=wrapper === "`" ? "" : wrapper;
     expect(render(`${wrapper}${source}${wrapper}${tail}`,opts)).toBe(`${kept}${render(`${p}:3-5`,opts)}${kept}${tail}`);
    }
   }
  });
  test(`${render.name} keeps nonexistent descendants plain without slash endpoints`, () => {
   const dir=join(root,"prune-boundary");
   mkdirSync(join(dir,"existing"),{recursive:true});
   writeFileSync(join(dir,"leaf.md"),"leaf");
   for(const prefix of [dir,"~/prune-boundary","./prune-boundary","prune-boundary",`../${basename(root)}/prune-boundary`]) {
    for(const descendant of ["leaf.md/nope","missing/nope","existing/missing/nope"]) {
     const source=`${prefix}/${descendant} passed ok`;
     expect(render(source,opts)).toBe(source);
    }
   }
  });
 }
 test("formatting and prose separators stay outside path targets", () => {
  for (const name of ["README.md", "missing.md"]) {
   const p=join(root,name);
   for (const suffix of ["", ":3", ":3-5", ":3:7"]) {
    const receipt=p+suffix, linked=md(receipt,p);
    for (const mark of ["*", "**", "_", "__", "***"]) {
     const text=`${mark}${receipt}${mark}.`;
     expect(linkMarkdown(text,opts)).toBe(`${mark}${linked}${mark}.`);
     expect(linkMarkdown(linkMarkdown(text,opts),opts)).toBe(`${mark}${linked}${mark}.`);
     expect(linkTerminal(text,opts)).toBe(`${mark}${linkTerminal(receipt,opts)}${mark}.`);
    }
    expect(linkMarkdown(`|${receipt}|`,opts)).toBe(`|${linked}|`);
    for (const dash of ["–","—"]) {
     expect(linkMarkdown(`${receipt}${dash}see`,opts)).toBe(`${linked}${dash}see`);
     expect(linkMarkdown(`${dash}${receipt}`,opts)).toBe(`${dash}${linked}`);
    }
   }
  }
  expect(linkMarkdown("_README.md_",opts)).toBe(`_${md(join(root,"README.md"),join(root,"README.md"))}_`);
  const spaced=join(root,"My Docs/plan.md");
  expect(linkMarkdown(`**${spaced}:3**`,opts)).toBe(`**${md(`${spaced}:3`,spaced)}**`);
  const a=join(root,"README.md"), b=join(root,"missing.md");
  expect(linkMarkdown(`|${a}|${b}|`,opts)).toBe(`|${md(a,a)}|${md(b,b)}|`);
 });
 test("space-bearing paths survive compact tables and separators before later slashes", () => {
  const a=join(root,"My File.md"), b=join(root,"Other File.md");
  for(const p of [a,b]) writeFileSync(p,"plan");
  for(const render of [linkMarkdown,linkTerminal]) {
   const expected=(p:string)=>{
    if(render === linkMarkdown) return md(p,p);
    const url=fileUrl(p), osc=(s:string)=>`\x1b]8;;${url}\x07${s}\x1b]8;;\x07`;
    return `${osc(p)} (${osc(url)})`;
   };
   expect(render(`|${a}|${b}|`,opts)).toBe(`|${expected(a)}|${expected(b)}|`);
   for(const source of [a,"./My File.md"]) {
    for(const separator of ["|","–","—"]) {
     expect(render(`${source}${separator}a/b`,opts)).toBe(`${expected(a)}${separator}a/b`);
    }
   }
  }
 });
 test("existing punctuation filenames win over formatting boundaries", () => {
  for (const name of ["punct**", "punct_", "punct|", "punct—see", "punct–see", "punct.", "punct!"]) {
   const p=join(root,name);
   writeFileSync(p,"punctuation");
   expect(linkMarkdown(p,opts)).toBe(md(p,p));
   expect(linkMarkdown(`${p}:3`,opts)).toBe(md(`${p}:3`,p));
   for(const mark of ["*","**","_"]) expect(linkMarkdown(`${mark}${p}${mark}`,opts)).toBe(`${mark}${md(p,p)}${mark}`);
  }
 });
 test("missing files retain punctuation in existing parent directories", () => {
  for(const name of ["parent—dir","parent|dir"]) {
   const dir=join(root,name);
   mkdirSync(dir);
   const p=join(dir,"missing.md");
   expect(linkMarkdown(p,opts)).toBe(md(p,p));
   expect(linkMarkdown(`**${p}**`,opts)).toBe(`**${md(p,p)}**`);
  }
 });
 test("receipt extraction rejects prose spaces but keeps delimited and existing spaced paths", () => {
  const p=join(root,"README.md"), spaced=join(root,"My Docs/plan.md"), missing=join(root,"My Docs/missing file.md");
  expect(linkedPaths(`the timer and/or the retry fires at 10:30, see ${p}:3`)).toEqual([{path:p,line:"3"}]);
  for (const text of [spaced+":3", `\`${missing}:3\``, `"${missing}:3"`, `'${missing}:3'`, md(`${missing}:3`,missing)]) {
   expect(linkedPaths(text)).toEqual([{path:text.startsWith(spaced) ? spaced : missing,line:"3"}]);
  }
 });
 test("optional receipt offsets refer to original text in source order", () => {
  const p=join(root,"README.md"), spaced=join(root,"My Docs/plan.md");
  const first=md(`${spaced}:3`,spaced), second=`${p}:3`, text=`before ${first} and ${second} after`;
  expect(linkedPaths(text,true)).toEqual([
   {path:spaced,line:"3",start:text.indexOf(first),end:text.indexOf(first)+first.length},
   {path:p,line:"3",start:text.indexOf(second),end:text.indexOf(second)+second.length},
  ]);
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
