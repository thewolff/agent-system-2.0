// Render-only links. Persisted files and ledger rows must keep raw paths.
import { AsyncLocalStorage } from "node:async_hooks";
import { statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMAND_LINE, SCRIPT_LINE } from "./rows/r01-turn-shape";

export interface LinkOptions {
 cwd?: string;
 home?: string;
 exists?: (p: string) => "file" | "dir" | null;
 handles?: ReadonlyMap<string, string>;
 repo?: { host: string; slug: string } | null;
}
export function fileUrl(absPath: string): string { return pathToFileURL(absPath).href.replace(/\(/g, "%28").replace(/\)/g, "%29"); }
// Backslash-bracket pairs are math delimiters in the host; entities stay literal labels.
const escapeMarkdown = (s: string): string => s.replace(/[\\`*_\[\]<>~&$]/g, c => c === "[" ? "&#91;" : c === "]" ? "&#93;" : `\\${c}`);
// Decode in one pass so a literal escaped ampersand cannot become a bracket entity.
const unescapeMarkdown = (s: string): string => s.replace(/\\([\\`*_\[\]<>~&$])|&#(91|93);/g, (_match, escaped: string | undefined, bracket: string | undefined) => escaped ?? (bracket === "91" ? "[" : "]"));
const HANDLE = /^(?:agent|artifact|history|local|memory|skill):\/\//;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const suffix = (s: string): { path: string; line: string | null } => {
 const m = /:(\d+(?:-\d+|:\d+)?)$/.exec(s);
 return m ? { path: s.slice(0, m.index), line: m[1]! } : { path: s, line: null };
};
const diskKind = (p: string): "file" | "dir" | null => { try { const s = statSync(p); return s.isDirectory() ? "dir" : s.isFile() ? "file" : null; } catch { return null; } };
const absolute = (p: string, o: LinkOptions): string => p.startsWith("~/") ? resolve(o.home ?? homedir(), p.slice(2)) : resolve(o.cwd ?? process.cwd(), p);
function pathTarget(s: string, o: LinkOptions, parent = true): string | null {
 if (SCHEME.test(s) || !s || /[\n\r]/.test(s)) return null;
 const p = suffix(s).path;
 if (/^\/+$/.test(p)) return null;
 if (!isAbsolute(p) && !p.startsWith("~/") && !p.includes("/") && !/^[^\s]+\.[a-z0-9]+$/i.test(p)) return null;
 const abs = absolute(p, o), exists = o.exists ?? diskKind;
 if (exists(abs)) return abs;
 if (parent && (isAbsolute(p) || p.startsWith("~/")) && (p.startsWith("~/") || p.slice(1).includes("/")) && exists(dirname(abs)) === "dir") return abs;
 return null;
}
function trimPunctuation(s: string): string {
 let previous:string;
 do {
  previous=s;
  s=s.replace(/[.,;:!?'"]+$/, "");
  if (s.endsWith(")") && (s.match(/\)/g)?.length ?? 0) > (s.match(/\(/g)?.length ?? 0)) s=s.slice(0,-1);
 } while(s !== previous);
 return s;
}
// Exact existing paths win before this prose-only boundary cleanup is used.
function trimPathToken(s: string, o: LinkOptions): string {
 s=trimPunctuation(s);
 // Remove only as much emphasis as needed: a real filename may itself end in "*" or "_".
 while (/[*_~]$/.test(s)) {
  s=s.slice(0,-1);
  if(pathTarget(s,o,false)) return s;
 }
 const slash=s.lastIndexOf("/");
 const parentExists=slash > 0 && /[|–—]/.test(s.slice(0,slash)) && (o.exists ?? diskKind)(absolute(s.slice(0,slash),o)) === "dir";
 const boundary=s.slice(parentExists ? slash+1 : 0).search(/[|–—]/);
 if(boundary >= 0) s=s.slice(0,boundary+(parentExists ? slash+1 : 0));
 return trimPunctuation(s);
}
function issueTarget(s: string, repo: LinkOptions["repo"]): string | null {
 const m = /^(pr|issue):\/\/([^?]*)(?:\?(.*))?$/.exec(s);
 if (!m) return null;
 const parts = m[2]!.split("/").filter(Boolean);
 let host = repo?.host ?? "github.com", slug = repo?.slug;
 if (parts.length >= 3 && (parts[0]!.includes(".") || (parts.length >= 4 && /^\d+$/.test(parts[3]!)))) host = parts.shift()!;
 if (parts.length >= 2 && !/^\d+$/.test(parts[0]!)) slug = `${parts.shift()}/${parts.shift()}`;
 if (!slug) return null;
 const kind = m[1] === "pr" ? "pull" : "issues";
 if (parts.length) {
  if (!/^[1-9]\d*$/.test(parts[0]!)) return null;
  if (parts.length > 1 && (m[1] !== "pr" || parts[1] !== "diff" || parts.length > 3 || (parts[2] && parts[2] !== "all" && !/^\d+$/.test(parts[2])))) return null;
  return `https://${host}/${slug}/${kind}/${parts[0]}${parts[1] === "diff" ? "/files" : ""}`;
 }
 const query = new URLSearchParams(m[3] ?? "");
 const search = [`is:${m[1] === "pr" ? "pr" : "issue"}`];
 for (const [k,v] of query) if (["state","author","label","search"].includes(k) && v && !(k === "state" && v === "all")) search.push(k === "state" ? `is:${v}` : k === "search" ? v : `${k}:${v}`);
 return `https://${host}/${slug}/${m[1] === "pr" ? "pulls" : "issues"}${m[3] ? `?${new URLSearchParams({q:search.join(" ")})}` : ""}`;
}
interface Hit { visible: string; target: string }
interface ExistingPath { raw: string; hit: Hit }
type PathCandidates = (start: number) => ExistingPath | null;
function pathHit(raw: string, path: string): Hit {
 const line = suffix(raw).line;
 return { visible: path + (line ? `:${line}` : ""), target: fileUrl(path) };
}

/** Index a span once, not every suffix at every prose token. */
function pathCandidates(text: string, o: LinkOptions): PathCandidates {
 if (!text.includes("/") && !text.includes(".")) return () => null;
 const ends: number[] = [], slashes: number[] = [];
 for (const m of text.matchAll(/\/|\s+/g)) {
  if (m[0] === "/") slashes.push(m.index!);
  else if (m.index! > 0 && !/\s/.test(text[m.index! - 1]!)) ends.push(m.index!);
 }
 if (text && !/\s/.test(text[text.length - 1]!)) ends.push(text.length);
 const after = (positions: number[], start: number): number => {
  let lo = 0, hi = positions.length;
  while (lo < hi) {
   const mid = (lo + hi) >>> 1;
   if (positions[mid]! < start) lo = mid + 1;
   else hi = mid;
  }
  return lo;
 };
 return start => {
  const first = after(ends, start + 1);
  if (first === ends.length || /\s/.test(text[start]!)) return null;
  const token = text.slice(start, ends[first]);
  if (SCHEME.test(token)) return null;
  const slashStart = after(slashes, start), slash = slashes[slashStart];
  // A slash-free run containing spaces cannot satisfy pathTarget's bare name.ext rule.
  // Without a slash or dot even the first token is ordinary prose: no suffix probes.
  if (slash === undefined && !token.includes(".")) return null;
  let limit = slash === undefined ? first + 1 : ends.length;
  for (let i = slashStart; i < slashes.length; i++) {
   const boundary = slashes[i]!;
   // Every crossed slash needs a real directory, including spaces in its name.
   // Include the slash so the first ~/ prefix expands to the configured home.
   if ((o.exists ?? diskKind)(absolute(text.slice(start, boundary + 1), o)) === "dir") continue;
   // Keep only indexed whitespace ends strictly before the impossible slash.
   // Inventing an end here would turn /file/nope into a partial /file link.
   limit = after(ends, boundary);
   // A prose separator can hide a spaced path: retain its containing token end
   // for trimPathToken, but never invent a slash endpoint or extend plain descendants.
   if (/[|–—]/.test(text.slice(i === slashStart ? start : slashes[i - 1]! + 1, boundary))) limit++;
   // Before the first slash, only the first bare name.ext token can be a path.
   if (i === slashStart) limit = Math.min(limit, first + 1);
   break;
  }
  // Across spaces only exact existence can win, longest first. Parent fallback is
  // deliberately left to the ordinary single-token parser.
  for (let i = limit - 1; i >= first; i--) {
   const found = existing(ends[i]!);
   if (found) return found;
  }
  return null;

  function existing(end: number): ExistingPath | null {
   let raw = end === ends[first] ? token : text.slice(start, end);
   let path = pathTarget(raw, o, false);
   if (!path) {
    const trimmed = trimPathToken(raw, o);
    if (trimmed !== raw) {
     raw = trimmed;
     path = pathTarget(raw, o, false);
    }
   }
   return path ? { raw, hit: pathHit(raw, path) } : null;
  }
 };
}
function target(s: string, o: LinkOptions, parent = true): Hit | null {
 if (/^https?:\/\//.test(s)) return {visible:s,target:s};
 const issue = issueTarget(s,o.repo);
 if (issue) return {visible:s,target:issue};
 if (SCHEME.test(s)) { const p = HANDLE.test(s) ? o.handles?.get(s) : null; return p ? {visible:s,target:fileUrl(p)} : null; }
 const p = pathTarget(s,o,parent);
 return p ? pathHit(s, p) : null;
}

// One walker owns exemptions for rendering, discovery, and raw handle expansion.
function walk(text: string, plain: (s: string) => string, code: (s: string) => string, linked: (s:string)=>string = s=>s, literal?: (line:string,start:number)=>{text:string;length:number}|null): string {
 let fence: { char: string; length: number } | null = null;
 let comment = false;
 return text.split(/(?<=\n)/).map(line => {
  const f = /^\s*(`{3,}|~{3,})/.exec(line);
  if (fence) { if (f && f[1]![0] === fence.char && f[1]!.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = null; return line; }
  if (!comment && f) { fence = {char:f[1]![0]!,length:f[1]!.length}; return line; }
  if (!comment && (COMMAND_LINE.test(line.trim()) || SCRIPT_LINE.test(line.trim()))) return line;
  let out = "", pos = 0;
  while (pos < line.length) {
   if (comment) { const end = line.indexOf("-->",pos); if (end < 0) return out + line.slice(pos); out += line.slice(pos,end+3); pos=end+3; comment=false; continue; }
   const rest = line.slice(pos);
   if (rest.startsWith("<!--")) { comment=true; continue; }
   const osc = /^\x1b\]8;;[^\x07]*\x07[^\x1b]*\x1b\]8;;\x07/.exec(rest);
   if (osc) { out += osc[0]; pos += osc[0].length; continue; }
   // Generated targets escape parentheses; accept ordinary balanced markdown destinations too.
   const protectedSpan = /^(?:!?\[(?:\\.|[^\]\\])*\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)|<(?:https?:\/\/|file:\/\/)[^>\n]*>)/.exec(rest);
   if (protectedSpan) { out += linked(protectedSpan[0]); pos += protectedSpan[0].length; continue; }
   const inline = /^(`+)([\s\S]*?)\1/.exec(rest);
   if (inline) { const rewritten = code(inline[2]!); out += rewritten === inline[2] ? inline[0] : rewritten; pos += inline[0].length; continue; }
   const whole=literal?.(line,pos);
   if(whole) { out+=whole.text; pos+=whole.length; continue; }
   let end = pos + 1;
   // Prose delimiters expose token starts, but are valid inside URL paths and queries.
   const boundary = SCHEME.test(rest) ? /\s/ : /[\s('"=]/;
   while (end < line.length && !line.startsWith("<!--",end) && !/[`\[<\x1b]/.test(line[end]!) && !(boundary.test(line[end-1]!) && !/\s/.test(line[end]!))) end++;
   out += plain(line.slice(pos,end)); pos=end;
  }
  return out;
 }).join("");
}
const TOKEN = /(?:[a-z][a-z0-9+.-]*:\/\/[^\s`<>\[\]]*|~\/[^\s`<>\[\]]+|\/(?!\/)[^\s`<>\[\]]+|(?:\.{1,2}\/)?[\w@][^\s`<>\[\]]*)/gi;
function transformPlain(s: string, o: LinkOptions, render: (h: Hit) => string): string {
 if (!s.includes("/") && !s.includes(".")) return s;
 let out="", pos=0;
 const tokens=new RegExp(TOKEN.source,TOKEN.flags);
 const existing = pathCandidates(s, o);
 let m:RegExpExecArray|null;
 while ((m=tokens.exec(s))) {
  if (m.index < pos || (m.index > 0 && /[\w/]/.test(s[m.index-1]!))) continue;
  let at=m.index,raw=m[0], hit: Hit | null = null;
  // Share the literal parser's eligibility guard and longest-existing selection.
  const whole = existing(m.index);
  if (whole && whole.raw.length > raw.length) { raw = whole.raw; hit = whole.hit; }
  if (!hit) {
   if (!SCHEME.test(raw) && pathTarget(raw,o,false)) hit=target(raw,o);
   else {
    if (!SCHEME.test(raw)) {
     const opening=/^(_{1,3})/.exec(raw);
     if(opening && raw.slice(opening[0].length).includes(opening[0])) { at+=opening[0].length; raw=raw.slice(opening[0].length); }
     raw=trimPathToken(raw,o);
    } else raw=trimPunctuation(raw);
    hit=target(raw,o);
   }
  }
  if (!hit) continue;
  out += s.slice(pos,at) + render(hit); pos=at+raw.length; tokens.lastIndex=pos;
 }
 return out+s.slice(pos);
}
function transform(text: string, o: LinkOptions, render: (h: Hit) => string, linked?: (s:string)=>string): string {
 let line = "", existing: PathCandidates | undefined;
 return walk(text,s=>transformPlain(s,o,render),s=>{
  const hit=target(s,o);
  // Inline commands and multiple references are not single path tokens.
  if (!hit || COMMAND_LINE.test(s) || (!SCHEME.test(s) && /\s/.test(s) && !pathTarget(s,o,false) && !/^(?:~\/|\/)/.test(s))) return s;
  return render(hit);
 },linked,(source,start)=>{
  if (source !== line || !existing) { line = source; existing = pathCandidates(source, o); }
  if (/\s/.test(source[start]!)) return null;
  // Check a whole existing path before treating filename backticks/brackets as Markdown.
  const whole = existing(start);
  if (whole) return {text:render(whole.hit),length:whole.raw.length};
  // Expose an adjacent path without consuming its Markdown wrapper or table/dash separator.
  const formatting=/^(?:\*{1,3}|_{1,3}|~{1,3}(?!\/)|[|–—])/.exec(source.slice(start,start+3));
  if(formatting) return {text:formatting[0],length:formatting[0].length};
  if (source[start] !== "/" && !(source[start] === "~" && source[start+1] === "/")) return null;
  const token=/^\S+/.exec(source.slice(start))?.[0];
  if(token && /^(?:\/|~\/)/.test(token) && /[`\[\]]/.test(token)) {
   const raw=trimPathToken(token,o),hit=target(raw,o);
   if(hit) return {text:render(hit),length:raw.length};
  }
  return null;
 });
}
export function linkMarkdown(text: string, opts: LinkOptions = {}): string {
 return transform(text,opts,h=>h.visible === h.target && /^https?:/.test(h.target) ? `<${h.target}>` : `[${escapeMarkdown(h.visible)}](${h.target})`);
}
export function linkTerminal(text: string, opts: LinkOptions = {}): string {
 const osc=(text:string,url:string)=>`\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
 const render=(h:Hit)=>/^file:/.test(h.target) ? `${osc(h.visible,h.target)} (${osc(h.target,h.target)})` : osc(h.visible,h.target);
 return transform(text,opts,render,s=>{
  const md=/^\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)$/.exec(s);
  if(md && /^(?:file|https?):\/\//.test(md[2]!)) return render({visible:unescapeMarkdown(md[1]!),target:md[2]!});
  if(/^<https?:\/\//.test(s)) return osc(s.slice(1,-1),s.slice(1,-1));
  return s;
 });
}
/** Openable references outside the same exempt spans, for an interrupted reply's display aside. */
export function renderedLinks(text:string):string[] {
 const found=new Set<string>();
 walk(text,s=>s,s=>s,s=>{
  if(/^<https?:\/\//.test(s) || /^\[(?:\\.|[^\]\\])*\]\((?:file|https?):\/\//.test(s)) found.add(s);
  return s;
 });
 return [...found];
}
export function internalHandles(text: string): string[] {
 const found=new Set<string>();
 const collect=(s:string):string=>{ for (const m of s.matchAll(/(?:agent|artifact|history|local|memory|skill):\/\/[^\s`<>\[\]]+/g)) found.add(trimPunctuation(m[0])); return s; };
 walk(text,collect,s=>HANDLE.test(s) && !/\s/.test(s) ? collect(s) : s);
 return [...found];
}
export async function resolveHandles(handles: string[], locate: (h: string) => Promise<string | null>): Promise<Map<string,string>> {
 const out=new Map<string,string>();
 await Promise.all([...new Set(handles)].map(async h=>{ try { const p=await locate(h); if(p) out.set(h,p); } catch { /* Unknown handles stay literal. */ } }));
 return out;
}
/** Raw expansion for persisted lane bodies; never introduces markdown or file URLs. */
export async function expandHandles(text: string, locate: (h:string)=>Promise<string|null>): Promise<string> {
 const handles=await resolveHandles(internalHandles(text),locate);
 const replace=(s:string)=>s.replace(/(?:agent|artifact|history|local|memory|skill):\/\/[^\s`<>\[\]]+/g,h=>{const key=trimPunctuation(h); return (handles.get(key) ?? key)+h.slice(key.length);});
 return walk(text,replace,replace);
}
interface PathReceipt { path:string; line:string|null }
interface ReceiptSpan extends PathReceipt { start:number; end:number }
/** Bare receipts never join prose spaces; delimited or existing spaced paths are unambiguous. */
export function linkedPaths(text: string): PathReceipt[];
export function linkedPaths(text: string, offsets: true): ReceiptSpan[];
export function linkedPaths(text: string, offsets = false): PathReceipt[] {
 const found:ReceiptSpan[]=[];
 // Mask spans without changing their offsets in the original report.
 let bare=text.replace(/\[((?:\\.|[^\]\\])*)\]\((file:\/\/[^\s)]+)\)/g,(whole:string,label:string,url:string,start:number)=>{
  try { found.push({path:fileURLToPath(url),line:suffix(unescapeMarkdown(label)).line,start,end:start+whole.length}); } catch { /* malformed links are not receipts */ }
  return whole.replace(/[^\n]/g," ");
 });
 bare=bare.replace(/(`+)(\/[^\n]*?)\1|"(\/[^"\n]*)"|'(\/[^'\n]*)'/g,(whole:string,_ticks:string|undefined,code:string|undefined,double:string|undefined,single:string|undefined,start:number)=>{
  const receipt=suffix(unescapeMarkdown(code ?? double ?? single!));
  if(!receipt.line) return whole;
  found.push({...receipt,start,end:start+whole.length});
  return whole.replace(/[^\n]/g," ");
 });
 for (const m of bare.matchAll(/\/[^\s`'"<>\[\]]*?:\d+(?:-\d+|:\d+)?/g)) {
  found.push({...suffix(unescapeMarkdown(m[0])),start:m.index!,end:m.index!+m[0].length});
 }
 // Overlapping lookaheads let a real path after a prose slash stand on its own.
 for (const m of bare.matchAll(/(?=(\/[^\n`'"<>\[\]]*?:\d+(?:-\d+|:\d+)?))/g)) {
  if(!/\s/.test(m[1]!)) continue;
  const receipt=suffix(unescapeMarkdown(m[1]!));
  if(diskKind(receipt.path)) found.push({...receipt,start:m.index!,end:m.index!+m[1]!.length});
 }
 found.sort((a,b)=>a.start-b.start || b.end-a.end);
 const out:ReceiptSpan[]=[];
 for(const receipt of found) if(!out.length || receipt.start >= out[out.length-1]!.end) out.push(receipt);
 return offsets ? out : out.map(({path,line})=>({path,line}));
}

export interface LinkContext {
 cwd:string;
 sessionManager: { getSessionFile?():string|undefined; getSessionId?():string; getHeader?():unknown };
 localProtocolOptions?: {getArtifactsDir?:()=>string|null;getSessionId?:()=>string|null};
}
export interface LinkCommands { getCommands?(): {name:string;source?:string;path?:string}[] }
export interface CallerResolveContext {
 cwd:string; sessionFile?:string; sessionId?:string; localProtocolOptions?:LinkContext["localProtocolOptions"];
 skills:{name:string;filePath:string;baseDir:string;description:string;source:string}[]; rules:never[];
}
export interface LinkRouter {
 locate(handle:string,rc:CallerResolveContext):Promise<string|null>;
 locateSync(handle:string,rc:CallerResolveContext):string|undefined;
}
export function resolveContext(pi: LinkCommands, ctx: LinkContext): CallerResolveContext {
 return {cwd:ctx.cwd,sessionFile:ctx.sessionManager.getSessionFile?.(),sessionId:ctx.sessionManager.getSessionId?.(),localProtocolOptions:ctx.localProtocolOptions,
  skills:(pi.getCommands?.() ?? []).filter(c=>c.source === "skill" && c.path).map(c=>({name:c.name.replace(/^skill:/,""),filePath:c.path!,baseDir:dirname(c.path!),description:"",source:"skill"})),rules:[]};
}
function skillPath(handle:string,rc:CallerResolveContext):string|null {
 const m=/^skill:\/\/([^/]+)(?:\/(.*))?$/.exec(handle);
 if(!m) return null;
 const skill=rc.skills.find(s=>s.name === m[1]);
 if(!skill) return null;
 try { const root=realpathSync(skill.baseDir); const p=realpathSync(m[2] ? resolve(skill.baseDir,decodeURIComponent(m[2])) : skill.filePath); return p === root || p.startsWith(root+sep) ? p : null; } catch { return null; }
}
export function callerLocate(pi:LinkCommands,ctx:LinkContext,router:LinkRouter|undefined=shared.router):(handle:string)=>Promise<string|null> {
 const rc=resolveContext(pi,ctx);
 return async handle=>handle.startsWith("skill://") ? skillPath(handle,rc) : HANDLE.test(handle) && router ? router.locate(handle,rc) : null;
}
/** Ledger bodies have no trustworthy session origin; never borrow the rendering caller's root. */
export type LinkProvenance = "current-caller" | "ledger";
export function syncHandles(text:string,pi:LinkCommands,ctx:LinkContext,router?:LinkRouter,provenance:LinkProvenance="current-caller"):Map<string,string> {
 const out=new Map<string,string>();
 if(provenance === "ledger") return out;
 const rc=resolveContext(pi,ctx);
 for(const h of internalHandles(text)) { if(!/^(local|memory):\/\//.test(h)) continue; try { const p=router?.locateSync(h,rc); if(p) out.set(h,p); } catch { /* unresolved */ } }
 return out;
}

// Extensions may load this module through separate relative graphs. Share only the host router
// and per-session caches, never active skills or rules (those are rebuilt from the caller).
const STATE = Symbol.for("agent-system-2.0/open-links");
interface LinkState { router?:LinkRouter; sessionOptions:WeakMap<object,LinkOptions>; repoLoads:WeakMap<object,Promise<void>> }
const global = globalThis as { [STATE]?:LinkState };
const shared:LinkState = global[STATE] ??= { sessionOptions:new WeakMap<object,LinkOptions>(),repoLoads:new WeakMap<object,Promise<void>>() };
/** Installed only from the host's extension-relative bare import, never a copied router module. */
export function setLinkRouter(router: LinkRouter | undefined): void { shared.router = router; }
const sessionOptions = shared.sessionOptions;
const repoLoads = shared.repoLoads;
interface LinkExec {
 exec?(command:string,args:string[],options:{cwd:string;timeout:number;signal:AbortSignal}):Promise<{code:number;stdout:string}>;
}
/** One cached literal-argv lookup; actual exec timeouts share a finite session-start budget. */
export function prepareLinkSession(pi:LinkExec,ctx:LinkContext):Promise<void> {
 let pending=repoLoads.get(ctx.sessionManager);
 if(pending) return pending;
 pending=(async()=>{
  let repo:LinkOptions["repo"]=null;
  if(pi.exec) {
   const controller=new AbortController(),until=Date.now()+2000;
   const expired=Promise.withResolvers<void>();
   const timer=setTimeout(()=>{controller.abort();expired.resolve();},2000);
   const discover=(async()=>{
    try {
     const gh=await pi.exec!("gh",["repo","view","--json","nameWithOwner,url"],{cwd:ctx.cwd,timeout:Math.min(1000,Math.max(1,until-Date.now())),signal:controller.signal});
     if(!controller.signal.aborted && gh.code === 0) { const data=JSON.parse(gh.stdout); if(typeof data.nameWithOwner === "string" && typeof data.url === "string") repo={host:new URL(data.url).host,slug:data.nameWithOwner}; }
    } catch { /* origin below */ }
    if(!repo && !controller.signal.aborted && Date.now() < until) try {
     const origin=await pi.exec!("git",["remote","get-url","origin"],{cwd:ctx.cwd,timeout:Math.min(1000,Math.max(1,until-Date.now())),signal:controller.signal});
     if(!controller.signal.aborted && origin.code === 0) { const m=/^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(origin.stdout.trim()); if(m) repo={host:m[1]!,slug:m[2]!}; }
    } catch { /* A checkout without a remote has no short-form PR target. */ }
   })();
   try { await Promise.race([discover,expired.promise]); } finally { clearTimeout(timer); }
  }
  sessionOptions.set(ctx.sessionManager,{cwd:ctx.cwd,repo});
 })();
 repoLoads.set(ctx.sessionManager,pending);
 return pending;
}
export function sessionLinkOptions(ctx:LinkContext):LinkOptions { return {...sessionOptions.get(ctx.sessionManager),cwd:ctx.cwd}; }
/** Caller-bound async storage transform for lane tools. No markdown or file:// is introduced. */
export async function expandCallerHandles(text:string,pi:LinkCommands,ctx:LinkContext,router:LinkRouter|undefined=shared.router):Promise<string> {
 return expandHandles(text,callerLocate(pi,ctx,router));
}
/**
 * Synchronous custom-message/notify adapter. The handler-local context lives in AsyncLocalStorage,
 * so concurrent sessions and timer callbacks never borrow another session's cwd or local root.
 * Passing ctx binds a tool's direct sendMessage call; omitting it wraps pi.on registrations.
 * Ledger-reading producers explicitly select "ledger": unresolved handles stay literal, but
 * stored absolute paths and URLs still link. Current-caller producers keep session-local lookup.
 */
export function linkedApi<T extends object>(pi:T,ctx?:LinkContext,router?:LinkRouter,provenance:LinkProvenance="current-caller"):T {
 const current=new AsyncLocalStorage<LinkContext>();
 const commands=pi as T & LinkCommands;
 const options=(at:LinkContext,text:string,source:LinkProvenance=provenance):LinkOptions=>({...sessionLinkOptions(at),handles:syncHandles(text,commands,at,router ?? shared.router,source)});
 const message=(m:any,at:LinkContext,source:LinkProvenance=provenance):any=>typeof m?.content === "string" ? {...m,content:linkMarkdown(m.content,options(at,m.content,source))} : Array.isArray(m?.content) ? {...m,content:m.content.map((p:any)=>p.type === "text" ? {...p,text:linkMarkdown(p.text ?? "",options(at,p.text ?? "",source))} : p)} : m;
 const context=(at:any):any=>new Proxy(at,{get(target,key){
  const value=Reflect.get(target,key);
  if((key === "setTimeout" || key === "setInterval") && typeof value === "function") return (callback:(...args:any[])=>any,...args:any[])=>value.call(target,(...values:any[])=>current.run(at,()=>callback(...values)),...args);
  if(key !== "ui" || !value) return typeof value === "function" ? value.bind(target) : value;
  return new Proxy(target.ui,{get(ui,field){const value=Reflect.get(ui,field); return field === "notify" ? (text:string,...args:any[])=>value.call(ui,linkTerminal(text,options(at,text)),...args) : typeof value === "function" ? value.bind(ui) : value;}});
 }});
 return new Proxy(pi,{get(target,key){
  const value=Reflect.get(target,key);
  if(key === "sendMessage") return (m:any,...args:any[])=>{const at=ctx ?? current.getStore(); return value.call(target,at ? message(m,at) : m,...args);};
  if(key === "registerTool") return (tool:any)=>value.call(target,{...tool,execute:(id:any,params:any,signal:any,onUpdate:any,at:any)=>current.run(at,async()=>{
   const result=await tool.execute(id,params,signal,onUpdate,context(at));
   return tool.name === "orchestrator_ledger" ? message(result,at,"ledger") : result;
  })});
  if(key === "on") return (event:string,handler:(event:any,ctx:any)=>any)=>value.call(target,event,(e:any,at:any)=>current.run(at,()=>{
   const result=handler(e,context(at));
   const finish=(r:any)=>event === "before_agent_start" && r?.message ? {...r,message:message(r.message,at)} : r;
   return result && typeof result.then === "function" ? result.then(finish) : finish(result);
  }));
  return typeof value === "function" ? value.bind(target) : value;
 }});
}
