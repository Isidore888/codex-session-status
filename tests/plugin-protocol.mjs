import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const env={...process.env};delete env.CODEX_APP_TOOLS_PIPE_PATH;
const child=spawn(process.execPath,['plugin/server.mjs'],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
let buffer='',next=1;const pending=new Map();const checks=[];
child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const item=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const waiter=pending.get(item.id);if(waiter){pending.delete(item.id);clearTimeout(waiter.timer);waiter.resolve(item)}}});
child.stderr.resume();
const request=(method,params={})=>new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('protocol-timeout'))},8000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
try{
  const init=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}},clientInfo:{name:'test-host',version:'1'}});
  assert.equal(init.result.protocolVersion,'2025-06-18');checks.push('MCP initialize');
  const tools=await request('tools/list');assert.equal(tools.result.tools.length,2);
  assert.equal(tools.result.tools[0]._meta.ui.resourceUri,'ui://session-status/panel.html');assert.equal(tools.result.tools[0].annotations.readOnlyHint,true);checks.push('read-only tools and UI resource');
  const resource=await request('resources/read',{uri:'ui://session-status/panel.html'});assert.equal(resource.result.contents[0].text,await readFile('plugin/panel.html','utf8'));checks.push('self-contained resource');
  const unbound=await request('tools/call',{name:'show_session_status',arguments:{},_meta:{'openai/session':process.env.CODEX_THREAD_ID}});assert.equal(unbound.result.structuredContent.binding.sessionId,null);checks.push('anonymous session rejected');
  const actual=await request('tools/call',{name:'show_session_status',arguments:{},_meta:{'openai/threadId':process.env.CODEX_THREAD_ID}});
  assert.equal(actual.result.structuredContent.binding.sessionId,process.env.CODEX_THREAD_ID);assert.equal(actual.result.structuredContent.mode.value,'Work');assert.ok(actual.result.structuredContent.session.value.totalTokens>0);checks.push('real local session with Work metadata');
  for(const [method,params]of [['resources/read',{uri:'file:///C:/Users/example/.codex/auth.json'}],['tools/call',{name:'send_message_to_thread',arguments:{}}],['tools/call',{name:'show_session_status',arguments:{session_id:'../../outside'}}]])assert.equal((await request(method,params)).error.code,-32602);
  checks.push('arbitrary tools, files and invalid identities denied');
  await writeFile('runtime/verification/plugin-protocol.json',JSON.stringify({passed:checks.length,checks},null,2)+'\n');console.log('PASS: '+checks.length+' MCP protocol checks');
}finally{child.stdin.end();await new Promise(resolve=>child.once('exit',resolve))}
