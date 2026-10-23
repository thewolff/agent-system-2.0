// Standalone: relative links.ts plus the running host's own bare internal-urls export.
import { callerLocate, internalHandles, linkMarkdown, renderedLinks, setLinkRouter, sessionLinkOptions, prepareLinkSession } from "../src/links";
import type { LinkCommands, LinkContext, LinkRouter } from "../src/links";

export const DISPLAY_LINKS = "as2-open-links";
interface Message { role?:string; stopReason?:string; customType?:string; content?:string|{type:string;text?:string;[key:string]:unknown}[]; [key:string]:unknown }
interface DisplayContext extends LinkContext {
 isIdle?():boolean;
 setTimeout(callback:()=>void,ms:number):unknown;
}
interface DisplayQueue {
 sessionId?:string;
 sessionFile?:string;
 lines:string[];
 ended:boolean;
 armed:boolean;
}
interface CompactionPreparation {
 messagesToSummarize:Message[];
 turnPrefixMessages:Message[];
 recentMessages?:Message[];
 recentEntryIds?:string[];
}
const FLUSH_MS=100,FLUSH_TRIES=3;
const isDisplayLink=(message:Message)=>message.customType === DISPLAY_LINKS;
interface OpenLinksAPI extends LinkCommands {
 on(name:string,handler:(event:any,ctx:any)=>any):void;
 sendMessage?(message:{customType:string;content:string;display:boolean}):void;
 exec?(command:string,args:string[],options:{cwd:string}):Promise<{code:number;stdout:string}>;
}
export interface OpenLinksOptions {
 router?:LinkRouter;
 locate?:(handle:string,ctx:LinkContext)=>Promise<string|null>;
 waitMs?:number;
}
let hostRouter:Promise<LinkRouter>|undefined;
async function runningRouter():Promise<LinkRouter> {
 hostRouter ??= import("@oh-my-pi/pi-coding-agent/internal-urls").then(({InternalUrlRouter})=>InternalUrlRouter.instance() as unknown as LinkRouter);
 return hostRouter;
}
export default function openLinks<T extends object>(input:T,options:OpenLinksOptions = {}):void {
 const pi=input as unknown as OpenLinksAPI;
 // Fake hosts without commands have no OMP module. Production always has getCommands; a failed
 // host import propagates through the awaited hook rather than quietly using a second router.
 const routerFor=async()=>options.router ?? (pi.getCommands ? await runningRouter() : undefined);
 const prepare=async(ctx:LinkContext)=>{const router=await routerFor(); if(router) setLinkRouter(router); await prepareLinkSession(pi,ctx); return router;};
 // A manager can survive /new or a session switch. Both identity and queue generation must match
 // before an old timer or locate completion can append anything to the current transcript.
 const queues=new WeakMap<LinkContext["sessionManager"],DisplayQueue>();
 const current=(q:DisplayQueue,ctx:LinkContext)=>queues.get(ctx.sessionManager) === q
  && q.sessionId === ctx.sessionManager.getSessionId?.()
  && q.sessionFile === ctx.sessionManager.getSessionFile?.();
 const queueOf=(ctx:LinkContext):DisplayQueue=>{
  let q=queues.get(ctx.sessionManager);
  if(!q || !current(q,ctx)) {
   q={sessionId:ctx.sessionManager.getSessionId?.(),sessionFile:ctx.sessionManager.getSessionFile?.(),lines:[],ended:false,armed:false};
   queues.set(ctx.sessionManager,q);
  }
  return q;
 };
 const arm=(q:DisplayQueue,ctx:DisplayContext):void=>{
  if(!current(q,ctx) || !q.ended || !q.lines.length || q.armed || !pi.sendMessage) return;
  q.armed=true;
  const flush=(tries:number):void=>{
   if(!current(q,ctx)) return;
   if(!q.ended) {q.armed=false;return;}
   // Unknown is not idle. No deliverAs or triggerTurn: a busy default send would steer the model.
   if(ctx.isIdle?.() !== true) {
    if(tries < FLUSH_TRIES) ctx.setTimeout(()=>flush(tries+1),FLUSH_MS);
    else q.armed=false; // Keep the queue for the next agent_end, as plan-path does.
    return;
   }
   const sending=q.lines.length;
   q.armed=false;
   try { pi.sendMessage!({customType:DISPLAY_LINKS,content:q.lines.join("\n"),display:true}); }
   catch(err) {process.stderr.write(`open-links: the display send failed: ${String(err)}\n`);return;}
   q.lines.splice(0,sending);
  };
  ctx.setTimeout(()=>flush(1),FLUSH_MS);
 };
 const enqueue=(q:DisplayQueue,ctx:DisplayContext,line:string):void=>{
  if(!current(q,ctx)) return;
  q.lines.push(line);
  // message_end is fire-and-forget, so a rewrite or late locate may finish after agent_end.
  arm(q,ctx);
 };
 for(const event of ["session_start","session_switch","session_branch"]) pi.on(event,async(_event,ctx)=>{
  queues.delete(ctx.sessionManager);
  await prepare(ctx);
 });
 pi.on("session_shutdown",(_event,ctx)=>{queues.delete(ctx.sessionManager);});
 pi.on("before_agent_start",async(_event,ctx)=>{queueOf(ctx).ended=false;await prepare(ctx);});
 pi.on("agent_start",(_event,ctx)=>{queueOf(ctx).ended=false;});
 pi.on("agent_end",(_event,ctx)=>{const q=queueOf(ctx);q.ended=true;arm(q,ctx);});

 async function rewrite(texts:string[],ctx:DisplayContext,q:DisplayQueue):Promise<string[]> {
  const router=await prepare(ctx);
  if(!current(q,ctx)) return texts;
  const locate=options.locate ? (h:string)=>options.locate!(h,ctx) : router ? callerLocate(pi,ctx,router) : async()=>null;
  const settled=new Map<string,string>();
  let expired=false;
  const pending=[...new Set(texts.flatMap(internalHandles))].map(async h=>{
   let p:string|null=null;
   try { p=await locate(h); } catch { return; }
   if(!p || !current(q,ctx)) return;
   if(!expired) settled.set(h,p);
   else enqueue(q,ctx,linkMarkdown(h,{...sessionLinkOptions(ctx),handles:new Map([[h,p]])}));
  });
  if(pending.length) {
   const deadline=Promise.withResolvers<void>();
   const timer=setTimeout(()=>{expired=true;deadline.resolve();},options.waitMs ?? 3000);
   await Promise.race([Promise.all(pending),deadline.promise]);
   clearTimeout(timer);
  }
  return current(q,ctx) ? texts.map(text=>linkMarkdown(text,{...sessionLinkOptions(ctx),handles:settled})) : texts;
 }
 pi.on("assistant_message",async(event:{message:Message},ctx:DisplayContext)=>{
  const content=event.message.content,q=queueOf(ctx);
  if(typeof content === "string") return {content:[{type:"text",text:(await rewrite([content],ctx,q))[0]!}]};
  if(!Array.isArray(content)) return undefined;
  // One rewrite gives every block the same deadline, with all locates concurrent.
  const texts=content.filter(p=>p.type === "text");
  const linked=await rewrite(texts.map(p=>p.text ?? ""),ctx,q);
  let index=0;
  return {content:content.map(p=>p.type === "text" ? {...p,text:linked[index++]!} : p)};
 });
 pi.on("message_end",async(event:{message:Message},ctx:DisplayContext)=>{
  const m=event.message;
  if(m.role !== "assistant" || (m.stopReason !== "aborted" && m.stopReason !== "error")) return;
  const q=queueOf(ctx);
  const text=typeof m.content === "string" ? m.content : (m.content ?? []).filter(p=>p.type === "text").map(p=>p.text ?? "").join("\n");
  const linked=(await rewrite([text],ctx,q))[0]!;
  const links=renderedLinks(linked);
  if(links.length) enqueue(q,ctx,`links in the interrupted reply:\n${links.join("\n")}`);
 });
 pi.on("context",(event:{messages:Message[]})=>{
  if(!event.messages.some(isDisplayLink)) return undefined;
  return {messages:event.messages.filter(m=>!isDisplayLink(m))};
 });
 pi.on("session_before_compact",(event:{preparation:CompactionPreparation})=>{
  const p=event.preparation;
  if(p.messagesToSummarize.some(isDisplayLink)) p.messagesToSummarize=p.messagesToSummarize.filter(m=>!isDisplayLink(m));
  if(p.turnPrefixMessages.some(isDisplayLink)) p.turnPrefixMessages=p.turnPrefixMessages.filter(m=>!isDisplayLink(m));
  const recent=p.recentMessages;
  if(recent?.some(isDisplayLink)) {
   if(p.recentEntryIds) p.recentEntryIds=p.recentEntryIds.filter((_,i)=>!(recent[i] && isDisplayLink(recent[i]!)));
   p.recentMessages=recent.filter(m=>!isDisplayLink(m));
  }
 });
}
