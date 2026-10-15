import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindSession, identifyMode, readThreadContext, StatusService } from '../plugin/lib/status.mjs';
import { DesktopQuotaReader } from '../plugin/lib/desktop-quota.mjs';
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const quota={rateLimitsByLimitId:{codex:{primary:{windowDurationMins:300,usedPercent:39,resetsAt:1791683809}}}};

test('executor UUIDs bind a conversation; anonymous and process-wide IDs do not',()=>{
  assert.deepEqual(bindSession({}, {'openai/session':A}),{sessionId:null,source:'unavailable'});
  assert.equal(bindSession({}, {'x-codex-turn-metadata':JSON.stringify({thread_id:A})}).sessionId,A);
  assert.equal(bindSession({session_id:A},{'openai/threadId':B}).sessionId,B);
  assert.equal(bindSession({session_id:A},{'openai/threadId':B,thread_id:A}).sessionId,null);
  assert.equal(bindSession({session_id:'../outside'}).sessionId,null);
});
test('explicit local originators distinguish Work and Codex; model/client hints cannot',()=>{
  assert.equal(identifyMode('Codex Desktop'),'Codex');
  assert.equal(identifyMode('codex_work_desktop'),'Work');
  for(const hint of ['vscode','gpt-6.1-sol','codex',null,'work','codex_desktop'])assert.equal(identifyMode(hint),null);
});
test('plugin includes exact shared cumulative parsers',async()=>{
  for(const file of ['metrics.mjs','sessions.mjs','mode.mjs','task-time.mjs'])assert.equal(await readFile('plugin/lib/'+file,'utf8'),await readFile('src/'+file,'utf8'));
});
test('project/conversation switch, numeric-only data, read-only mode DB and quota TTL',async()=>{
  const root=path.resolve('runtime','plugin-fixture-'+randomUUID());
  const sessions=path.join(root,'sessions');await mkdir(sessions,{recursive:true});
  const dbPath=path.join(root,'state_5.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, originator TEXT, title TEXT)');
  const insert=db.prepare('INSERT INTO threads VALUES (?,?,?)');
  insert.run(A,'codex_work_desktop','PRIVATE_BODY_DO_NOT_EXPORT');insert.run(B,'Codex Desktop','PRIVATE_TITLE_DO_NOT_EXPORT');db.close();
  for(const [id,total]of [[A,100],[B,900]]){
    const file=path.join(sessions,id+'.jsonl');
    await writeFile(file,JSON.stringify({type:'session_meta',payload:{id}})+'\n'+JSON.stringify({timestamp:'2026-10-11T01:00:00Z',type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:total,input_tokens:80,cached_input_tokens:40}}}})+'\n');
  }
  try{
    const before=await readFile(dbPath);let now=100000,calls=0,fail=false;
    const service=new StatusService({codexRoot:root,dataDirectory:root,clock:()=>now,quotaReader:async()=>{calls++;if(fail)throw new Error('failed');return quota}});
    const first=await service.read({}, {'openai/threadId':A});
    assert.equal(first.mode.value,'Work');assert.equal(first.session.value.totalTokens,100);
    assert.equal(first.quota.value.remainingPercent,61);assert.equal(calls,1);
    const second=await service.read({}, {'openai/threadId':B});
    assert.equal(second.mode.value,'Codex');assert.equal(second.session.value.totalTokens,900);assert.equal(calls,1);
    assert.ok(!JSON.stringify(second).includes('PRIVATE_'));assert.deepEqual(await readFile(dbPath),before);
    now+=60001;fail=true;const stale=await service.read({}, {'openai/threadId':B});
    assert.equal(calls,2);assert.equal(stale.quota.stale,true);assert.equal(stale.quota.value.remainingPercent,61);
    const missing=await service.read({},{});assert.equal(missing.session.value,null);assert.equal(missing.mode.value,null);
    assert.equal(readThreadContext(dbPath,'33333333-3333-4333-8333-333333333333').mode,null);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
});
test('missing 300-minute bucket stays empty; no alternate-period substitution',async()=>{
  const service=new StatusService({codexRoot:path.resolve('runtime/nonexistent'),dataDirectory:path.resolve('runtime/nonexistent'),
    quotaReader:async()=>({rateLimits:{limitId:'codex',primary:{windowDurationMins:10080,usedPercent:1,resetsAt:1791683809}}})});
  const result=await service.read({session_id:A},{});assert.equal(result.quota.value,null);assert.equal(result.quota.stale,false);
});
test('native adapter cannot invoke arbitrary methods or tools',async()=>{
  const reader=new DesktopQuotaReader('\\\\.\\pipe\\not-used');
  await assert.rejects(reader.request('account/logout',{}),/native-method-denied/);
  await assert.rejects(reader.request('tools/call',{tool:'send_message_to_thread',arguments:{}}),/native-tool-denied/);
  assert.equal(reader.nextId,1);
});
test('absent native channel never creates a credential or network fallback',async()=>{
  const reader=new DesktopQuotaReader(null);await assert.rejects(reader.read(A,'Work'),/desktop-pipe-unavailable/);
});
test('native reader uses executor transport and discards account/credit metadata',async()=>{
  const reader=new DesktopQuotaReader(null);const calls=[];
  reader.request=async(method,params)=>{calls.push({method,params});
    if(method==='tools/list')return{tools:[{name:'get_usage_limits',namespace:'codex_app'}]};
    return{success:true,contentItems:[{type:'inputText',text:JSON.stringify({...quota,
      accountId:'PRIVATE_ACCOUNT_DO_NOT_EXPORT',rateLimitResetCredits:{credits:[{id:'PRIVATE_CREDIT_DO_NOT_EXPORT'}]}})}]};
  };
  const result=await reader.read(A,'Work');
  assert.equal(calls[1].params.callerSource,'codex');assert.ok(calls[1].params.turnId);
  assert.equal(calls[1].params.tool,'get_usage_limits');assert.deepEqual(calls[1].params.arguments,{});
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));assert.equal(result.rateLimits.primary.windowDurationMins,300);
});
