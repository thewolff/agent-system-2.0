import { afterEach, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import openLinks, { DISPLAY_LINKS } from "../extensions/open-links";
import { callerLocate, expandCallerHandles, fileUrl, linkedApi, linkTerminal, prepareLinkSession, resolveContext, sessionLinkOptions, syncHandles } from "../src/links";
import type { LinkContext, LinkRouter } from "../src/links";

const root=mkdtempSync(join(process.env.AS2_SCRATCH ?? tmpdir(),"open-links-"));
const path=join(root,"plan.md");
const labelPath=path.replace(/[\\`*_\[\]<>~&$]/g,"\\$&");
writeFileSync(path,"plan");
function host(isIdle:()=>boolean=()=>true) {
 const handlers:Record<string,((event:any,ctx:any)=>any)[]>={};
 const sent:any[]=[],sendOptions:any[]=[],steered:any[]=[];
 const pi={on:(name:string,fn:(event:any,ctx:any)=>any)=>{(handlers[name] ??= []).push(fn);},sendMessage:(m:any,options?:any)=>{
  sent.push(m);sendOptions.push(options);
  // The host routes a default busy send to steer, then drains that queue into a resumed turn.
  if(!isIdle()) steered.push(m);
 }};
 return {pi,sent,sendOptions,steered,async emit(name:string,event:any,ctx:any){let last:any; for(const h of handlers[name] ?? []) {const r=await h(event,ctx); if(r !== undefined) last=r;} return last;}};
}
const context=(name:string):LinkContext & {isIdle():boolean;setTimeout(callback:()=>void,ms:number):unknown}=>({
 cwd:root,sessionManager:{getSessionFile:()=>join(root,`${name}.jsonl`),getSessionId:()=>name},
 isIdle:()=>true,setTimeout:(callback,ms)=>setTimeout(callback,ms),
});
const flush=async()=>{for(let i=0;i<30;i++) await Promise.resolve();};
const message=(text:string)=>({message:{role:"assistant",content:[{type:"text",text}]}});
const inert:LinkRouter={locate:async()=>null,locateSync:()=>undefined};
afterEach(()=>vi.useRealTimers());

describe("T6 model link lifecycle",()=>{
 test("context without display-only link asides is a no-op, including an empty history",async()=>{
  const h=host();openLinks(h.pi,{router:inert});
  const kept={role:"custom",customType:"other-extension",content:"keep"};
  for(const messages of [[],[{role:"user",content:"keep"},kept]]) {
   const before=structuredClone(messages);
   expect(await h.emit("context",{messages},context("no-asides"))).toBeUndefined();
   expect(messages).toEqual(before);
  }
 });
 test("context removes only link asides without mutating retained messages or the input",async()=>{
  const h=host();openLinks(h.pi,{router:inert});
  const kept={role:"custom",customType:"other-extension",content:"keep"};
  const aside={role:"custom",customType:DISPLAY_LINKS,content:"display only"};
  const messages=[aside,kept,aside];
  const result=await h.emit("context",{messages},context("asides"));
  expect(result.messages).toEqual([kept]);
  expect(result.messages[0]).toBe(kept);
  expect(messages).toEqual([aside,kept,aside]);
  expect(await h.emit("context",{messages:[aside]},context("only-asides"))).toEqual({messages:[]});
 });
 test.each(["aborted","error"])("interrupted %s reply waits for agent_end and idle, excluded from model context",async stopReason=>{
  vi.useFakeTimers();let idle=false;
  const h=host(()=>idle); openLinks(h.pi,{router:inert}); const ctx={...context("interrupted"),isIdle:()=>idle};
  const interrupted=`${path}\n\`\`\`review-findings\n[do not link](https://hidden.example)\n\`\`\`\n<!-- <https://hidden.example> -->`;
  await h.emit("message_end",{message:{...message(interrupted).message,stopReason}},ctx);
  expect(h.sent).toEqual([]);
  await h.emit("agent_end",{},ctx);
  vi.advanceTimersByTime(100);await flush();expect(h.sent).toEqual([]);
  idle=true;
  vi.advanceTimersByTime(100);await flush();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({customType:DISPLAY_LINKS,display:true});
  expect(h.sent[0].content).toBe(`links in the interrupted reply:\n[${labelPath}](${fileUrl(path)})`);
  const kept={role:"user",content:"keep"};
  expect(await h.emit("context",{messages:[kept,{role:"custom",...h.sent[0]}]},ctx)).toEqual({messages:[kept]});
  expect(h.steered).toEqual([]);
  expect(h.sendOptions).toEqual([undefined]);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(1000);await flush();
  expect(h.sent).toHaveLength(1);
 });
 test("local and artifact handles use concurrent async locate",async()=>{
  const h=host();const calls:string[]=[];
  openLinks(h.pi,{locate:async h=>{calls.push(h);return path;}});
  const result=await h.emit("assistant_message",message("local://a artifact://b"),context("async"));
  expect(calls).toEqual(["local://a","artifact://b"]);
  expect(result.content[0].text).toBe(`[local://a](${fileUrl(path)}) [artifact://b](${fileUrl(path)})`);
 });
 test("one shared 3 s bound: 1 s settles inline, 5 s follows once, never holds nothing else",async()=>{
  vi.useFakeTimers();let idle=false;const h=host(()=>idle);const calls:string[]=[];
  const ctx={...context("bounded"),isIdle:()=>idle};
  openLinks(h.pi,{locate:handle=>{
   calls.push(handle);
   const deferred=Promise.withResolvers<string|null>();
   if(handle !== "artifact://never") setTimeout(()=>deferred.resolve(path),handle === "local://fast" ? 1000 : 5000);
   return deferred.promise;
  }});
  let result:any;
  const blocks=[{type:"text",text:`${path} local://fast`},{type:"toolCall",id:"c1",name:"read",arguments:{}},{type:"text",text:"artifact://slow artifact://never"}];
  void h.emit("assistant_message",{message:{role:"assistant",content:blocks}},ctx).then(r=>{result=r;});
  await flush(); expect(calls).toHaveLength(3);
  vi.advanceTimersByTime(1000); await flush(); expect(result).toBeUndefined();
  vi.advanceTimersByTime(1999); await flush(); expect(result).toBeUndefined();
  vi.advanceTimersByTime(1); await flush();
  expect(result.content[0].text).toBe(`[${labelPath}](${fileUrl(path)}) [local://fast](${fileUrl(path)})`);
  expect(result.content[1]).toEqual(blocks[1]);
  expect(result.content[2].text).toBe("artifact://slow artifact://never");
  expect(h.sent).toHaveLength(0);
  vi.advanceTimersByTime(2000); await flush();
  expect(h.sent).toHaveLength(0);
  await h.emit("agent_end",{},ctx);
  vi.advanceTimersByTime(100);await flush();expect(h.sent).toHaveLength(0);
  idle=true;vi.advanceTimersByTime(100);await flush();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].content).toBe(`[artifact://slow](${fileUrl(path)})`);
  expect(h.steered).toEqual([]);
  expect(h.sendOptions).toEqual([undefined]);
  vi.advanceTimersByTime(100000); await flush();expect(h.sent).toHaveLength(1);
 });
 test("a lone 1 s handle settles before deadline; null and throw never send follow-ups",async()=>{
  vi.useFakeTimers();const h=host();
  openLinks(h.pi,{locate:handle=>{
   if(handle === "artifact://bad") return Promise.reject(new Error("missing"));
   if(handle !== "local://fast") return Promise.resolve(null);
   const deferred=Promise.withResolvers<string|null>();
   setTimeout(()=>deferred.resolve(path),1000);
   return deferred.promise;
  }});
  let result:any;void h.emit("assistant_message",message("local://fast artifact://bad history://missing"),context("fast")).then(r=>{result=r;});
  await flush();vi.advanceTimersByTime(999);await flush();expect(result).toBeUndefined();
  vi.advanceTimersByTime(1);await flush();expect(result.content[0].text).toContain(`[local://fast](${fileUrl(path)}) artifact://bad history://missing`);
  vi.advanceTimersByTime(10000);await flush();expect(h.sent).toHaveLength(0);
 });
 test("late resolution after idle agent_end still flushes once without a new model turn",async()=>{
  vi.useFakeTimers();const h=host();const ctx=context("late-idle");
  const located=Promise.withResolvers<string|null>();
  openLinks(h.pi,{waitMs:10,locate:()=>located.promise});
  const reply=h.emit("assistant_message",message("artifact://late"),ctx);
  await flush();vi.advanceTimersByTime(10);await flush();
  expect((await reply).content[0].text).toBe("artifact://late");
  await h.emit("agent_end",{},ctx);
  located.resolve(path);await flush();
  expect(h.sent).toEqual([]);
  vi.advanceTimersByTime(100);await flush();
  expect(h.sent.map(m=>m.content)).toEqual([`[artifact://late](${fileUrl(path)})`]);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(1000);await flush();
  expect(h.sent).toHaveLength(1);
  expect(h.steered).toEqual([]);expect(h.sendOptions).toEqual([undefined]);
 });
 test("fire-and-forget abort rewrite can settle after agent_end while a new turn is busy",async()=>{
  vi.useFakeTimers();let idle=false;const h=host(()=>idle);
  const ctx={...context("abort-race"),isIdle:()=>idle};
  const located=Promise.withResolvers<string|null>();
  openLinks(h.pi,{locate:()=>located.promise});
  const ended=h.emit("message_end",{message:{...message(`artifact://abort ${path}`).message,stopReason:"aborted"}},ctx);
  await flush();await h.emit("agent_end",{},ctx);
  await h.emit("before_agent_start",{},ctx);
  located.resolve(path);await ended;
  idle=true;vi.advanceTimersByTime(1000);await flush();
  // The old agent_end cannot authorize a send in the new turn, even in a transient idle window.
  expect(h.sent).toEqual([]);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(100);await flush();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].content).toContain("links in the interrupted reply:");
  expect(h.sent[0].content).toContain(`[artifact://abort](${fileUrl(path)})`);
  expect(h.sent[0].content).toContain(`[${labelPath}](${fileUrl(path)})`);
  expect(h.steered).toEqual([]);expect(h.sendOptions).toEqual([undefined]);
 });
 test("an aborted lookup past the deadline queues both immediate and late links without busy sends",async()=>{
  vi.useFakeTimers();let idle=false;const h=host(()=>idle);
  const ctx={...context("abort-late"),isIdle:()=>idle};
  const located=Promise.withResolvers<string|null>();
  openLinks(h.pi,{waitMs:10,locate:()=>located.promise});
  const ended=h.emit("message_end",{message:{...message(`${path} artifact://abort-late`).message,stopReason:"aborted"}},ctx);
  await flush();vi.advanceTimersByTime(10);await ended;
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(100);await flush();
  located.resolve(path);await flush();expect(h.sent).toEqual([]);
  idle=true;vi.advanceTimersByTime(100);await flush();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].content).toBe(`links in the interrupted reply:\n[${labelPath}](${fileUrl(path)})\n[artifact://abort-late](${fileUrl(path)})`);
  expect(h.steered).toEqual([]);expect(h.sendOptions).toEqual([undefined]);
 });
 test("busy retries are bounded and the next agent_end sends the retained queue once",async()=>{
  vi.useFakeTimers();let idle=false;const h=host(()=>idle);
  const ctx={...context("busy-retry"),isIdle:()=>idle};
  openLinks(h.pi,{router:inert});
  await h.emit("message_end",{message:{...message(path).message,stopReason:"aborted"}},ctx);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(1000);await flush();
  expect(h.sent).toEqual([]);
  idle=true;vi.advanceTimersByTime(1000);await flush();expect(h.sent).toEqual([]);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(100);await flush();
  expect(h.sent).toHaveLength(1);expect(h.steered).toEqual([]);
 });
 test.each(["session_start","session_switch","session_branch","session_shutdown"])("%s drops queued lines, armed timers and outstanding late results",async reset=>{
  vi.useFakeTimers();let idle=false;const h=host(()=>idle);
  const ctx={...context("reset"),isIdle:()=>idle};
  const located=Promise.withResolvers<string|null>();
  openLinks(h.pi,{waitMs:10,locate:()=>located.promise});
  const reply=h.emit("assistant_message",message("artifact://old-session"),ctx);
  await flush();vi.advanceTimersByTime(10);await reply;
  await h.emit("message_end",{message:{...message(path).message,stopReason:"aborted"}},ctx);
  await h.emit("agent_end",{},ctx);
  await h.emit(reset,{},ctx);
  located.resolve(path);await flush();idle=true;
  vi.advanceTimersByTime(1000);await flush();expect(h.sent).toEqual([]);
  await h.emit("session_start",{},ctx);
  await h.emit("message_end",{message:{...message(path).message,stopReason:"error"}},ctx);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(100);await flush();
  expect(h.sent.map(m=>m.content)).toEqual([`links in the interrupted reply:\n[${labelPath}](${fileUrl(path)})`]);
  expect(h.steered).toEqual([]);
 });
 test("a reused manager changing identity cannot publish an old pending locate",async()=>{
  vi.useFakeTimers();const h=host();let id="old";
  const ctx={...context("mutable"),sessionManager:{getSessionId:()=>id,getSessionFile:()=>join(root,`${id}.jsonl`)}};
  const located=Promise.withResolvers<string|null>();
  openLinks(h.pi,{waitMs:10,locate:()=>located.promise});
  const reply=h.emit("assistant_message",message("artifact://old-identity"),ctx);
  await flush();vi.advanceTimersByTime(10);await reply;
  await h.emit("agent_end",{},ctx);
  id="new";located.resolve(path);await flush();
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(1000);await flush();
  expect(h.sent).toEqual([]);
 });
 test("concurrent session queues stay isolated even with identical session ids and file names",async()=>{
  vi.useFakeTimers();const h=host();const a=context("same"),b=context("same");
  const pending=new Map([[a.sessionManager,Promise.withResolvers<string|null>()],[b.sessionManager,Promise.withResolvers<string|null>()]]);
  openLinks(h.pi,{waitMs:10,locate:(_handle,ctx)=>pending.get(ctx.sessionManager)!.promise});
  const replies=[h.emit("assistant_message",message("artifact://a"),a),h.emit("assistant_message",message("artifact://b"),b)];
  await flush();vi.advanceTimersByTime(10);await Promise.all(replies);
  pending.get(a.sessionManager)!.resolve(path);pending.get(b.sessionManager)!.resolve(path);await flush();
  await h.emit("agent_end",{},b);vi.advanceTimersByTime(100);await flush();
  expect(h.sent.map(m=>m.content)).toEqual([`[artifact://b](${fileUrl(path)})`]);
  await h.emit("agent_end",{},a);vi.advanceTimersByTime(100);await flush();
  expect(h.sent.map(m=>m.content)).toEqual([`[artifact://b](${fileUrl(path)})`,`[artifact://a](${fileUrl(path)})`]);
 });
 test("unknown idle state never sends a display aside",async()=>{
  vi.useFakeTimers();const h=host();
  const {isIdle,...ctx}=context("unknown-idle");
  openLinks(h.pi,{router:inert});
  await h.emit("message_end",{message:{...message(path).message,stopReason:"aborted"}},ctx);
  await h.emit("agent_end",{},ctx);vi.advanceTimersByTime(1000);await flush();
  expect(h.sent).toEqual([]);
 });
 test("compaction removes asides from all arrays and keeps recent entry ids aligned without mutating source arrays",async()=>{
  const h=host();openLinks(h.pi,{router:inert});
  const aside={role:"custom",customType:DISPLAY_LINKS,content:"display only"};
  const user={role:"user",content:"keep"},other={role:"custom",customType:"other-extension",content:"keep"};
  const summary=[aside,user,aside],prefix=[other,aside],recent=[aside,user,aside,other,aside],ids=["a","b","c","d","e"];
  const preparation={messagesToSummarize:summary,turnPrefixMessages:prefix,recentMessages:recent,recentEntryIds:ids,firstKeptEntryId:"b"};
  expect(await h.emit("session_before_compact",{preparation},context("compact"))).toBeUndefined();
  expect(preparation).toEqual({messagesToSummarize:[user],turnPrefixMessages:[other],recentMessages:[user,other],recentEntryIds:["b","d"],firstKeptEntryId:"b"});
  expect(preparation.messagesToSummarize[0]).toBe(user);expect(preparation.recentMessages[1]).toBe(other);
  expect(summary).toEqual([aside,user,aside]);expect(prefix).toEqual([other,aside]);
  expect(recent).toEqual([aside,user,aside,other,aside]);expect(ids).toEqual(["a","b","c","d","e"]);
 });
 test("compaction without asides is a no-op, and optional recent arrays and all-aside histories are supported",async()=>{
  const h=host();openLinks(h.pi,{router:inert});
  const ctx=context("compact-empty"),aside={role:"custom",customType:DISPLAY_LINKS};
  const kept={role:"user",content:"keep"};
  const preparation={messagesToSummarize:[kept],turnPrefixMessages:[],recentMessages:[kept],recentEntryIds:["keep"]};
  const arrays={...preparation};
  await h.emit("session_before_compact",{preparation},ctx);
  for(const key of Object.keys(arrays) as (keyof typeof arrays)[]) expect(preparation[key]).toBe(arrays[key]);
  const minimal={messagesToSummarize:[aside],turnPrefixMessages:[aside]};
  await h.emit("session_before_compact",{preparation:minimal},ctx);
  expect(minimal).toEqual({messagesToSummarize:[],turnPrefixMessages:[]});
  const noIds={messagesToSummarize:[],turnPrefixMessages:[],recentMessages:[aside]};
  await h.emit("session_before_compact",{preparation:noIds},ctx);
  expect(noIds).toEqual({messagesToSummarize:[],turnPrefixMessages:[],recentMessages:[]});
 });
});

// Use the installed host selected by PATH, even when the runner isolates HOME.
// Bound the parent walk at the filesystem root, as in surface/test/linked-api.test.ts.
let hostRoot:string|null=null;
const omp=Bun.which("omp");
if(omp) {
 let dir=dirname(realpathSync(omp));
 while(basename(dir) !== "@oh-my-pi" && dirname(dir) !== dir) dir=dirname(dir);
 const candidate=join(dir,"pi-coding-agent","src");
 if(existsSync(join(candidate,"internal-urls/index.ts"))) hostRoot=candidate;
}
describe("T6 real host router caller isolation",()=>{
 test.skipIf(hostRoot === null)("two concurrent sessions, async and sync local routing; no main session or override",async()=>{
  const {InternalUrlRouter,LocalProtocolHandler}=await import(join(hostRoot!,"internal-urls/index.ts"));
  const {AgentRegistry}=await import(join(hostRoot!,"registry/agent-registry.ts"));
  LocalProtocolHandler.resetOverrideForTests();
  expect(AgentRegistry.global().list().filter((r:any)=>r.kind === "main")).toHaveLength(0);
  const router=InternalUrlRouter.instance() as LinkRouter;
  const roots=[join(root,"session-a"),join(root,"session-b")];
  for(const r of roots) {mkdirSync(join(r,"local"),{recursive:true});writeFileSync(join(r,"local/h.md"),r);}
  const contexts=roots.map((r,i)=>({...context(`session-${i}`),localProtocolOptions:{getArtifactsDir:()=>r,getSessionId:()=>`session-${i}`}}));
  const h=host();openLinks(h.pi,{router});
  const results=await Promise.all(contexts.map(ctx=>h.emit("assistant_message",message("local://h.md"),ctx)));
  const syncResults=await Promise.all(contexts.map(async ctx=>syncHandles("local://h.md",{},ctx,router)));
  for(let i=0;i<2;i++) {
   const dest=join(roots[i]!,"local/h.md");
   expect(results[i].content[0].text).toBe(`[local://h.md](${fileUrl(dest)})`);
   expect(syncResults[i]!.get("local://h.md")).toBe(dest);
  }
  expect(results[0].content[0].text).not.toBe(results[1].content[0].text);
  const missing=context("no-options");
  expect((await h.emit("assistant_message",message("local://h.md"),missing)).content[0].text).toBe("local://h.md");
  expect(syncHandles("local://h.md",{},missing,router).size).toBe(0);
 });
 test.skipIf(hostRoot === null)("caller skills contained to their own directory; disabled skills and rules never use global snapshots",async()=>{
  const {InternalUrlRouter}=await import(join(hostRoot!,"internal-urls/index.ts"));
  const skills=await import(join(hostRoot!,"extensibility/skills.ts"));
  const rules=await import(join(hostRoot!,"capability/rule.ts"));
  const previousSkills=skills.getActiveSkills(),previousRules=rules.getActiveRules();
  const x=join(root,"skills/x"), y=join(root,"skills/y"),global=join(root,"global");
  for(const d of [x,y,global]) {mkdirSync(d,{recursive:true});writeFileSync(join(d,"SKILL.md"),"skill");}
  writeFileSync(join(x,"ref.md"),"ref");symlinkSync(join(y,"SKILL.md"),join(x,"esc.md"));
  skills.setActiveSkills([{name:"x",description:"global",filePath:join(global,"SKILL.md"),baseDir:global,source:"test"}]);
  rules.setActiveRules([{name:"r",path:join(global,"SKILL.md"),description:"global",content:"rule"}]);
  try {
   const router=InternalUrlRouter.instance() as LinkRouter;
   const pi={getCommands:()=>[{name:"skill:x",source:"skill",path:join(x,"SKILL.md")}]};
   const ctx=context("skill");const locate=callerLocate(pi,ctx,router);
   expect(resolveContext(pi,ctx)).toMatchObject({cwd:root,sessionFile:join(root,"skill.jsonl"),sessionId:"skill",rules:[]});
   expect(await locate("skill://x")).toBe(join(x,"SKILL.md"));
   expect(await locate("skill://x/ref.md")).toBe(join(x,"ref.md"));
   expect(await locate("skill://x/esc.md")).toBeNull();
   expect(await locate("skill://x/../y/SKILL.md")).toBeNull();
   expect(await callerLocate({getCommands:()=>[]},ctx,router)("skill://x")).toBeNull();
   expect(await locate("rule://r")).toBeNull();
   const h=host();openLinks({...h.pi,...pi},{router});
   const r=await h.emit("assistant_message",message("skill://x skill://x/ref.md skill://x/esc.md skill://x/../y/SKILL.md rule://r"),ctx);
   expect(r.content[0].text).toBe(`[skill://x](${fileUrl(join(x,"SKILL.md"))}) [skill://x/ref.md](${fileUrl(join(x,"ref.md"))}) skill://x/esc.md skill://x/../y/SKILL.md rule://r`);
   expect(await expandCallerHandles("local://missing skill://x",pi,ctx,router)).toBe(`local://missing ${join(x,"SKILL.md")}`);
  } finally {skills.setActiveSkills(previousSkills);rules.setActiveRules(previousRules);}
 });
});

describe("synchronous shared custom-message adapter",()=>{
 test("sendMessage ordering, before-start message, caller notify and only ledger tool output",async()=>{
  const h=host();const tools:Record<string,any>={};const notices:string[]=[];
  const callbacks:(()=>void)[]=[];
  const api=linkedApi({...h.pi,registerTool:(t:any)=>{tools[t.name]=t;}},undefined,inert);
  api.on("before_agent_start",(_e,ctx)=>{
   api.sendMessage({content:path});ctx.ui.notify(path);
   ctx.setTimeout(()=>api.sendMessage({content:path}),1);
   ctx.setInterval(()=>api.sendMessage({content:path}),2);
   return {message:{content:path}};
  });
  const ctx={...context("wrapper"),ui:{notify:(s:string)=>{notices.push(s);}},setTimeout:(fn:()=>void)=>{callbacks.push(fn);},setInterval:(fn:()=>void)=>{callbacks.push(fn);}};
  const started=h.emit("before_agent_start",{},ctx);
  expect(h.sent[0].content).toBe(`[${labelPath}](${fileUrl(path)})`);
  expect(notices[0]).toBe(linkTerminal(path));
  expect((await started).message.content).toBe(`[${labelPath}](${fileUrl(path)})`);
  callbacks.forEach(fn=>fn());
  expect(h.sent).toHaveLength(3);
  expect(h.sent.every(m=>m.content === `[${labelPath}](${fileUrl(path)})`)).toBe(true);
  for(const name of ["orchestrator_ledger","read"]) api.registerTool({name,execute:async()=>({content:[{type:"text",text:path}]})});
  expect((await tools.orchestrator_ledger.execute("id",{},undefined,undefined,ctx)).content[0].text).toBe(`[${labelPath}](${fileUrl(path)})`);
  expect((await tools.read.execute("id",{},undefined,undefined,ctx)).content[0].text).toBe(path);
  expect(linkTerminal(`[${labelPath}](${fileUrl(path)})`)).toBe(linkTerminal(path));
 });
});

describe("per-session repository targets",()=>{
 test("literal argv gh lookup is cached and failed gh falls back to origin",async()=>{
  const calls:{command:string;args:string[];cwd:string}[]=[];
  const pi={exec:async(command:string,args:string[],opts:{cwd:string})=>{
   calls.push({command,args,cwd:opts.cwd});
   return command === "gh" ? {code:1,stdout:""} : {code:0,stdout:"git@ghe.co:owner/repo.git\n"};
  }};
  const ctx=context("repo");
  await Promise.all([prepareLinkSession(pi,ctx),prepareLinkSession(pi,ctx)]);
  expect(calls).toEqual([
   {command:"gh",args:["repo","view","--json","nameWithOwner,url"],cwd:root},
   {command:"git",args:["remote","get-url","origin"],cwd:root},
  ]);
  expect(sessionLinkOptions(ctx).repo).toEqual({host:"ghe.co",slug:"owner/repo"});
 });
});
