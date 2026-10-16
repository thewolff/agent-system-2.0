// Standalone: relative links.ts plus the running host's own bare internal-urls export.
import { callerLocate, internalHandles, linkMarkdown, renderedLinks, setLinkRouter, sessionLinkOptions, prepareLinkSession } from "../src/links";
import type { LinkCommands, LinkContext, LinkRouter } from "../src/links";

export const DISPLAY_LINKS = "as2-open-links";
interface Message { role?:string; stopReason?:string; customType?:string; content?:string|{type:string;text?:string;[key:string]:unknown}[]; [key:string]:unknown }
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
 pi.on("session_start",async(_event,ctx)=>{await prepare(ctx);});
 pi.on("before_agent_start",async(_event,ctx)=>{await prepare(ctx);});

 async function rewrite(texts:string[],ctx:LinkContext):Promise<string[]> {
  const router=await prepare(ctx);
  const locate=options.locate ? (h:string)=>options.locate!(h,ctx) : router ? callerLocate(pi,ctx,router) : async()=>null;
  const settled=new Map<string,string>();
  let expired=false;
  const pending=[...new Set(texts.flatMap(internalHandles))].map(async h=>{
   let p:string|null=null;
   try { p=await locate(h); } catch { return; }
   if(!p) return;
   if(!expired) settled.set(h,p);
   else pi.sendMessage?.({customType:DISPLAY_LINKS,content:linkMarkdown(h,{...sessionLinkOptions(ctx),handles:new Map([[h,p]])}),display:true});
  });
  if(pending.length) {
   const deadline=Promise.withResolvers<void>();
   const timer=setTimeout(()=>{expired=true;deadline.resolve();},options.waitMs ?? 3000);
   await Promise.race([Promise.all(pending),deadline.promise]);
   clearTimeout(timer);
  }
  return texts.map(text=>linkMarkdown(text,{...sessionLinkOptions(ctx),handles:settled}));
 }
 pi.on("assistant_message",async(event:{message:Message},ctx:LinkContext)=>{
  const content=event.message.content;
  if(typeof content === "string") return {content:[{type:"text",text:(await rewrite([content],ctx))[0]!}]};
  if(!Array.isArray(content)) return undefined;
  // One rewrite gives every block the same deadline, with all locates concurrent.
  const texts=content.filter(p=>p.type === "text");
  const linked=await rewrite(texts.map(p=>p.text ?? ""),ctx);
  let index=0;
  return {content:content.map(p=>p.type === "text" ? {...p,text:linked[index++]!} : p)};
 });
 pi.on("message_end",async(event:{message:Message},ctx:LinkContext)=>{
  const m=event.message;
  if(m.role !== "assistant" || (m.stopReason !== "aborted" && m.stopReason !== "error")) return;
  const text=typeof m.content === "string" ? m.content : (m.content ?? []).filter(p=>p.type === "text").map(p=>p.text ?? "").join("\n");
  const linked=(await rewrite([text],ctx))[0]!;
  const links=renderedLinks(linked);
  if(links.length) pi.sendMessage?.({customType:DISPLAY_LINKS,content:`links in the interrupted reply:\n${links.join("\n")}`,display:true});
 });
 pi.on("context",(event:{messages:Message[]})=>{
  if(!event.messages.some(m=>m.customType === DISPLAY_LINKS)) return undefined;
  return {messages:event.messages.filter(m=>m.customType !== DISPLAY_LINKS)};
 });
}
