// Temporary local preview host. This is not native desktop-plugin acceptance.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UUID } from '../src/metrics.mjs';
import { StatusService } from '../plugin/lib/status.mjs';
import { DesktopQuotaReader } from '../plugin/lib/desktop-quota.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sessionId=process.env.CODEX_THREAD_ID;
if(!sessionId||!UUID.test(sessionId))throw new Error('current-session-unavailable');
const native=new DesktopQuotaReader(process.env.CODEX_APP_TOOLS_PIPE_PATH);
const service=new StatusService({codexRoot:path.join(os.homedir(),'.codex'),dataDirectory:path.join(root,'runtime','plugin'),quotaReader:(id,mode)=>native.read(id,mode)});
const panel=await readFile(path.join(root,'plugin','panel.html'),'utf8');
const host='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>会话状态 · 本机预览</title><style>html,body{margin:0;background:light-dark(#fff,#212121);color-scheme:light dark}iframe{border:0;width:100%;height:260px}</style></head><body><iframe src="/panel" title="会话状态"></iframe><script>const frame=document.querySelector("iframe");const notify=(method,params)=>frame.contentWindow.postMessage({jsonrpc:"2.0",method,params},location.origin);addEventListener("message",async event=>{if(event.source!==frame.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=="2.0")return;const m=event.data;if(m.method==="ui/initialize"){frame.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2026-01-26",hostCapabilities:{serverTools:{}},hostContext:{theme:matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light"}}},location.origin);setTimeout(()=>notify("ui/notifications/tool-input",{arguments:{session_id:'+JSON.stringify(sessionId)+'}}),20)}else if(m.method==="tools/call"){try{const data=await(await fetch("/data",{cache:"no-store"})).json();frame.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,result:{structuredContent:data}},location.origin)}catch{frame.contentWindow.postMessage({jsonrpc:"2.0",id:m.id,error:{code:-32603,message:"Status unavailable"}},location.origin)}}else if(m.method==="ui/notifications/size-changed"){frame.style.height=Math.max(120,Math.min(1000,m.params?.height||260))+"px"}});</script></body></html>';
let port;
const server=http.createServer(async(request,response)=>{
  const origin=request.headers.origin;
  if(request.method!=='GET'||(origin&&origin!=='http://127.0.0.1:'+port)){response.writeHead(403);response.end();return}
  response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
  try{
    if(request.url==='/data'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(await service.read({session_id:sessionId},{})));return}
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'");
    if(request.url==='/')response.end(host);else if(request.url==='/panel')response.end(panel);else{response.writeHead(404);response.end()}
  }catch{response.writeHead(503);response.end('{}')}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
await mkdir(path.join(root,'runtime','plugin'),{recursive:true});
await writeFile(path.join(root,'runtime','plugin','preview.json'),JSON.stringify({pid:process.pid,port,startedAt:Date.now(),expiresAfterMinutes:20},null,2)+'\n');
console.log(JSON.stringify({url:'http://127.0.0.1:'+port,pid:process.pid,nativePluginAcceptance:false}));
const expiry=setTimeout(()=>server.close(),20*60*1000);
server.on('close',()=>clearTimeout(expiry));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearTimeout(expiry);server.close()});
