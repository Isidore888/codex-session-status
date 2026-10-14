import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, rm, mkdtemp, readFile } from 'node:fs/promises';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import path from 'node:path';
import { readUsage, readQuota, quotaState, nextQuotaRefresh } from '../src/metrics.mjs';
import { SessionStore } from '../src/sessions.mjs';
import { readDesktopQuota, quotaProbeExpression } from '../src/quota-bridge.mjs';
import { loopbackUrl } from '../src/cdp.mjs';
import { identifyMode, mergeModes } from '../src/mode.mjs';
import { advanceTask, chooseTask } from '../src/task-time.mjs';
import { runMonitor } from '../src/monitor.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
test('native geometry checks the visible host when hidden pages share its UUID', async () => {
  const source = await readFile(new URL('../scripts/verify-client.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const inspectExpression = ');
  const end = source.indexOf('\nfor (const page of pages)', start);
  const expression = runInNewContext(source.slice(start,end) + '\ninspectExpression');
  const rect = (left,top,width,height) => ({left,top,width,height,right:left+width,bottom:top+height});
  const composer = {getBoundingClientRect:()=>rect(10,10,500,100),
    querySelector:()=>({getBoundingClientRect:()=>rect(20,20,400,40)}),querySelectorAll:()=>[]};
  const host = (inactive,width) => ({dataset:{statusThread:A},parentElement:composer,
    closest:(selector)=>inactive && selector.includes(inactive) ? {} : null,getBoundingClientRect:()=>rect(20,80,width,20),
    shadowRoot:{querySelectorAll:()=>Array(6),querySelector:()=>null}});
  const hidden = host('[data-app-shell-active-page="false"]',0), visible = host(false,450);
  let hosts = [hidden,visible];
  const environment = {window:{innerWidth:600,innerHeight:200,
    __CODEX_SESSION_STATUS_V1__:{inspect:()=>[{threadId:A,visible:true}]}},
    document:{querySelectorAll:()=>hosts}};
  let result = runInNewContext(expression,environment);
  assert.equal(result[0].geometryPass,true);assert.equal(result[0].cells,6);
  for (const marker of ['[aria-hidden="true"]','[inert]']) {
    hosts=[host(marker,450),host(false,800)];result=runInNewContext(expression,environment);
    assert.equal(result[0].geometryPass,false,marker+' positive-area hidden host cannot mask the visible overflow');
  }
  hosts=[hidden];result=runInNewContext(expression,environment);
  assert.equal(result[0].geometryPass,false,'hidden page cannot pass native acceptance');
  hosts=[host(false,0)];result=runInNewContext(expression,environment);
  assert.equal(result[0].geometryPass,false,'zero-width row cannot pass native acceptance');
});
test('failed quota reads retry promptly with bounded backoff; success returns to minute cadence',()=>{
  let schedule={failures:0,nextAttemptAt:0};let now=1000;
  for(const delay of [2000,5000,10000,15000,30000,30000]){
    schedule=nextQuotaRefresh(schedule,now,false);
    assert.equal(schedule.nextAttemptAt,now+delay);now=schedule.nextAttemptAt;
  }
  schedule=nextQuotaRefresh(schedule,now,true);
  assert.deepEqual(schedule,{failures:0,nextAttemptAt:now+60000});
  assert.equal(nextQuotaRefresh(schedule,now+60000,false).nextAttemptAt,now+62000);
});
const snapshot = (total, input = 100, cached = 80) => ({ total_token_usage: {
  total_tokens: total, input_tokens: input, cached_input_tokens: cached,
  output_tokens: 20, reasoning_output_tokens: 10,
} });
const header = (id) => JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n';
const event = (time, info) => JSON.stringify({ type: 'event_msg', timestamp: time,
  payload: { type: 'token_count', info } }) + '\n';

test('task timing follows root UUIDs, completion/abort, duplicate starts and out-of-order events', () => {
  const base=Date.parse('2026-10-12T00:00:00Z');
  const marker=(type,id,seconds,extra={})=>({type:'event_msg',timestamp:new Date(base+seconds*1000).toISOString(),payload:{type,turn_id:id,root_turn_id:id,...extra}});
  const started=advanceTask(null,marker('task_started',A,0,{started_at:base/1000}));
  assert.equal(started.state,'running');
  assert.equal(advanceTask(started,marker('task_started',B,2,{root_turn_id:A})),started,'child task cannot replace root timing');
  const ended=advanceTask(started,marker('task_complete',A,10,{started_at:base/1000,duration_ms:9876,last_agent_message:'PRIVATE_MESSAGE'}));
  assert.equal(ended.durationMs,9876);
  assert.equal(JSON.stringify(ended).includes('PRIVATE_MESSAGE'),false);
  assert.equal(advanceTask(ended,marker('task_started',A,0,{started_at:base/1000})),ended,'duplicate start cannot reopen a completed turn');
  const next=advanceTask(ended,marker('task_started',B,20,{started_at:base/1000+20}));
  assert.equal(advanceTask(next,marker('task_complete',A,21,{started_at:base/1000,duration_ms:9876})),next,'late old completion cannot overwrite the newest root');
  const aborted=advanceTask(next,marker('turn_aborted',B,25));
  assert.equal(aborted.state,'aborted');assert.equal(aborted.durationMs,5000);
  assert.equal(advanceTask(next,marker('turn_aborted',A,26)),next,'another turn abort cannot stop the current root');
  assert.equal(chooseTask(started,ended),ended);
  assert.equal(advanceTask(null,marker('task_complete',A,10,{duration_ms:10000})).startedAt,base);
});

test('same-second consecutive roots reset timing and late old completion cannot overwrite them', () => {
  const base=Date.parse('2026-10-12T00:00:00Z');
  const event=(type,id,ms,extra={})=>({type:'event_msg',timestamp:new Date(base+ms).toISOString(),payload:{type,turn_id:id,root_turn_id:id,started_at:base/1000,...extra}});
  const first=advanceTask(null,event('task_started',A,100));
  const aborted=advanceTask(first,event('turn_aborted',A,200));
  const second=advanceTask(aborted,event('task_started',B,800));
  assert.equal(second.turnId,B);assert.equal(second.state,'running');
  const late=advanceTask(second,event('task_complete',A,2100,{duration_ms:100}));
  assert.equal(late.turnId,B);assert.equal(late.state,'running');
  const ended=advanceTask(second,event('task_complete',B,2900,{duration_ms:2100}));
  assert.equal(ended.orderAt,base+800);assert.equal(ended.durationMs,2100);
  const resume=advanceTask(null,event('task_complete',B,2900,{duration_ms:2100}));
  const merged=chooseTask(resume,second);
  assert.equal(merged.state,'completed');assert.equal(merged.orderAt,base+800);
  assert.equal(chooseTask(aborted,merged).turnId,B);
});

test('task timing merges resumed logs, waits for complete append and stays bound on read failure', async () => {
  const parent=path.resolve('runtime','unit');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(path.join(parent,'task-time-'));
  const base=Date.parse('2026-10-12T00:00:00Z');
  const marker=(type,seconds,extra={})=>JSON.stringify({type:'event_msg',timestamp:new Date(base+seconds*1000).toISOString(),payload:{type,turn_id:A,root_turn_id:A,started_at:base/1000,...extra}})+'\n';
  try{
    const file=path.join(directory,'start.jsonl');const resume=path.join(directory,'resume.jsonl');
    await writeFile(file,header(A)+marker('task_started',0));
    await writeFile(resume,header(A));await writeFile(path.join(directory,'other.jsonl'),header(B));
    const store=new SessionStore(directory);
    assert.equal((await store.read(A)).task.value.state,'running');
    assert.equal((await store.read(B)).task.value,null);
    const end=marker('task_complete',12,{duration_ms:12000,last_agent_message:'DO_NOT_RETAIN'});
    await appendFile(resume,end.slice(0,-1));
    assert.equal((await store.read(A)).task.value.state,'running');
    await appendFile(resume,'\n');
    const completed=(await store.read(A)).task;
    assert.equal(completed.value.durationMs,12000);assert.equal(completed.stale,false);
    assert.equal(JSON.stringify(completed).includes('DO_NOT_RETAIN'),false);
    await rm(resume);assert.deepEqual((await store.read(A)).task,{value:completed.value,stale:true});
    assert.equal((await store.read(B)).task.value,null);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('cumulative snapshot is authoritative; output and reasoning are not added again', () => {
  assert.deepEqual(readUsage(snapshot(120)), { totalTokens: 120, cacheHitPercent: 80 });
  assert.equal(readUsage(snapshot(0, 0, 0)).cacheHitPercent, null);
  const missing = snapshot(120); delete missing.total_token_usage.cached_input_tokens;
  assert.equal(readUsage(missing).cacheHitPercent, null);
  assert.equal(readUsage(snapshot(120, 100, 101)).cacheHitPercent, null);
  assert.equal(readUsage(snapshot(-1)), null);
});

test('only the codex 300-minute bucket is selected, including secondary position', () => {
  const five = { windowDurationMins: 300, usedPercent: 25, resetsAt: 1791659281 };
  assert.deepEqual(readQuota({ rateLimits: { limitId: 'codex', primary: five } }),
    { remainingPercent: 75, resetsAt: 1791659281 });
  assert.equal(readQuota({ rateLimits: { limitId: 'codex', primary: { ...five, windowDurationMins: 10080 } } }), null);
  assert.equal(readQuota({ rateLimitsByLimitId: {}, rateLimits: { limitId: 'codex', primary: five } }), null);
  assert.equal(readQuota({ rateLimits: { limitId: 'other', primary: five } }), null);
  assert.equal(readQuota({ rateLimitsByLimitId: { codex: {
    primary: { windowDurationMins: 10080 }, secondary: five } } }).remainingPercent, 75);
  assert.equal(readQuota({ rateLimits: { primary: { ...five, usedPercent: null } } }).remainingPercent, null);
  assert.equal(readQuota({ rateLimits: { primary: { ...five, usedPercent: 105 } } }).remainingPercent, 0);
  assert.equal(readQuota({ rateLimits: { primary: { ...five, resetsAt: null } } }).resetsAt, null);
});

test('transient failure retains stale values; successful missing window clears them', () => {
  const old = { value: { remainingPercent: 75, resetsAt: 1791659281 }, stale: false };
  assert.deepEqual(quotaState(old, null, true), { ...old, stale: true });
  assert.equal(quotaState(old, {}).value, null);
  assert.equal(quotaState(old, {}).stale, false);
});

test('resume files, duplicates, partial append, corrections, and another thread remain distinct', async () => {
  const root = path.resolve('runtime', 'unit');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'sessions-'));
  try {
    const first = path.join(directory, 'first.jsonl');
    const resumed = path.join(directory, 'resume.jsonl');
    const record = event('2026-10-10T12:00:00Z', snapshot(120));
    await writeFile(first, header(A) + record + record);
    await writeFile(resumed, header(A) + record);
    await writeFile(path.join(directory, 'other.jsonl'), header(B)
      + event('2026-10-10T12:10:00Z', snapshot(999)));
    const store = new SessionStore(directory);
    assert.equal((await store.read(A)).value.totalTokens, 120);
    assert.equal((await store.read(B)).value.totalTokens, 999);
    const next = event('2026-10-10T12:02:00Z', snapshot(240, 200, 150));
    await appendFile(resumed, next.slice(0, -2));
    assert.equal((await store.read(A)).value.totalTokens, 120);
    await appendFile(resumed, next.slice(-2));
    assert.deepEqual((await store.read(A)).value, { totalTokens: 240, cacheHitPercent: 75 });
    await appendFile(first, event('2026-10-10T12:03:00Z', snapshot(230, 190, 152)));
    assert.equal((await store.read(A)).value.totalTokens, 230);
    await writeFile(first, header(A) + event('2026-10-10T12:05:00Z', snapshot(300)));
    assert.equal((await store.read(A)).value.totalTokens, 300);
    assert.equal((await store.read('../../auth')).value, null);
    await rm(resumed);
    assert.equal((await store.read(A)).stale, true);
    await writeFile(first, header(B) + event('2026-10-10T12:06:00Z', snapshot(400)));
    assert.equal((await store.read(A)).value.totalTokens, 300, 'failed replacement retains prior thread data');
    assert.equal((await store.read(A)).stale, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CDP endpoint accepts loopback only and rejects credential-bearing URLs', () => {
  assert.equal(loopbackUrl('ws://127.0.0.1:9345/devtools/page/1').port, '9345');
  for (const address of ['ws://10.0.0.1:9345/a', 'ws://localhost:9345/a',
    'ws://user:password@127.0.0.1:9345/a', 'https://127.0.0.1:9345/a']) {
    assert.throws(() => loopbackUrl(address));
  }
});

test('mode maps exact local metadata, conflicts stay unknown and session failures remain bound', async () => {
  assert.equal(identifyMode('Codex Desktop'), 'Codex');
  assert.equal(identifyMode('codex_work_desktop'), 'Work');
  for (const name of ['codex','ChatGPT','Codex Desktop extra',null]) assert.equal(identifyMode(name), null);
  assert.equal(mergeModes(['Work', null, 'Work']), 'Work');
  assert.equal(mergeModes(['Work', 'Codex']), null);
  const root = path.resolve('runtime', 'unit');
  await mkdir(root, {recursive:true});
  const directory = await mkdtemp(path.join(root, 'mode-'));
  try {
    const make = (id, originator) => JSON.stringify({type:'session_meta',payload:{id,originator}})+'\n';
    const file = path.join(directory, 'a.jsonl');
    await writeFile(file, make(A,'codex_work_desktop')+event('2026-10-11T00:00:00Z',snapshot(120)));
    await writeFile(path.join(directory,'b.jsonl'), make(B,'Codex Desktop'));
    const store = new SessionStore(directory);
    assert.deepEqual((await store.read(A)).mode, {value:'Work',stale:false});
    const b = await store.read(B);
    assert.equal(b.value, null); assert.equal(b.mode.value, 'Codex');
    assert.equal((await store.read('33333333-3333-4333-8333-333333333333')).mode.value, null);
    await rm(file);
    assert.deepEqual((await store.read(A)).mode, {value:'Work',stale:true});
    assert.equal((await store.read(B)).mode.value, 'Codex');
    await writeFile(file, make(A,'codex_work_desktop'));
    await writeFile(path.join(directory,'conflict.jsonl'),make(A,'Codex Desktop'));
    assert.equal((await store.read(A,true)).mode.value,null);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('desktop bridge calls only quota read and does not export account or credential fields', async () => {
  const calls = [];
  const client = { hostId: 'local', requestPromises: new Map(), async sendRequest(method) {
    calls.push(method);
    return { accountId: 'PRIVATE', token: 'SECRET', rateLimits: {
      limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791659281 },
      credits: { opaqueSecret: 'PRIVATE' },
    } };
  } };
  const root = { child: { client } };
  Object.defineProperty(root, 'secretGetter', { get() { throw new Error('must-not-read-getters'); } });
  globalThis.window = { __codexRoot: { _internalRoot: { current: root } } };
  try {
    const result = await readDesktopQuota();
    assert.equal(readQuota(result).remainingPercent, 75);
    assert.deepEqual(calls, ['account/rateLimits/read']);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    delete root.child;
    await assert.rejects(readDesktopQuota(), /client-unavailable/);
  } finally { delete globalThis.window; }
});

test('desktop bridge supports the installed class prototype without calling getters', async () => {
  class Client {
    hostId = 'local'; requestPromises = new Map(); calls = 0;
    async sendRequest(method, params) {
      assert.equal(this.hostId, 'local'); assert.equal(method, 'account/rateLimits/read');
      assert.equal(params, undefined); this.calls++;
      return {rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:20,resetsAt:1}}};
    }
  }
  const client = new Client();
  globalThis.window={__codexRoot:{_internalRoot:{current:{client}}}};
  try { assert.equal(readQuota(await readDesktopQuota()).remainingPercent,80); assert.equal(client.calls,1); }
  finally { delete globalThis.window; }
});

test('quota probe treats temporarily missing managers as retryable and discards raw errors', async () => {
  globalThis.window={};
  try {
    assert.deepEqual(await (0,eval)(quotaProbeExpression), {code:'request-failed'});
    const client={hostId:'local',requestPromises:new Map(),async sendRequest(){throw Error('PRIVATE SECRET');}};
    window.__codexRoot={_internalRoot:{current:{client}}};
    const result=await (0,eval)(quotaProbeExpression);
    assert.deepEqual(result,{code:'request-failed'});
  } finally {delete globalThis.window;}
});

test('actual monitor recovers after manager or UI loss; unknown UI never receives updates', async () => {
  for(const scenario of ['manager','transient-ui','persistent-ui']){
    let now=1000;const states=[],updates=[];let context;
    const client={hostId:'local',requestPromises:new Map(),async sendRequest(){return {rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:now>=130000?30:25,resetsAt:1900000000}}};}};
    const root={client};
    const connection={send:async()=>{},close(){},evaluate:async(expression)=>{
      if(expression.includes('compatibility()'))return scenario==='persistent-ui'||(scenario==='transient-ui'&&now>=61000&&now<100000)?'unsupported':'supported';
      if(expression==='contexts')return [A];
      if(expression==='update')return {rows:1};
      if(expression===quotaProbeExpression){
        if(scenario==='manager'&&now>=61000&&now<130000)delete root.client;else root.client=client;
        return runInContext(quotaProbeExpression,context);
      }
      return {};
    }};
    context=createContext({path,Map,performance:{now:()=>0},window:{__codexRoot:{_internalRoot:{current:root}}},
      runtime:'virtual-runtime',pipeAddress:'virtual-pipe',control:async()=>null,mkdir:async()=>{},log:async()=>{},
      writeFile:async(file,value)=>states.push(JSON.parse(value)),quotaState,nextQuotaRefresh,quotaProbeExpression,
      installExpression:'install',contextsExpression:'contexts',removeExpression:'remove',
      updateExpression:(data)=>{updates.push({at:now,quota:structuredClone(data.quota)});return 'update';},
      CdpSession:{connect:async()=>connection},listTargets:async()=>now>=145000?[]:[{id:'fixture',webSocketDebuggerUrl:'ws://127.0.0.1/fixture'}],
      SessionStore:class{async read(){return {value:null,stale:false};}},process:{pid:1,on(){},off(){}},
      net:{createServer:()=>({once(){},listen(name,resolve){resolve();},close(resolve){resolve();}})},
      Date:class extends Date{static now(){return now;}},setTimeout:(callback,ms)=>{now+=ms;queueMicrotask(callback);return 1;},clearTimeout(){}});
    await runInContext('('+runMonitor.toString()+')({port:9345,sessionsRoot:"virtual-sessions"})',context);
    assert.equal(states.at(-1).exitReason,'stopped');
    assert.equal(states.length,2,'one monitor survives until endpoint absence');
    if(scenario==='manager'){
      assert.ok(updates.some(({at,quota})=>at>=61000&&quota.stale&&quota.value?.remainingPercent===75),'temporary failure retains the last quota');
      assert.ok(updates.some(({at,quota})=>at>=130000&&!quota.stale&&quota.value?.remainingPercent===70),'same-client manager restoration resumes fresh reads');
    } else if(scenario==='transient-ui') {
      assert.ok(updates.some(({at})=>at<61000),'valid UI initially receives updates');
      assert.ok(!updates.some(({at})=>at>=61000&&at<100000),'unknown UI receives no updates for more than30s');
      assert.ok(updates.some(({at})=>at>=100000),'same monitor resumes after the UI becomes valid');
    } else {
      assert.equal(updates.length,0,'permanently unknown UI receives no updates');
    }
  }
});

test('quota bridge finds a local hook-ref request client before large cache graphs', async () => {
  let calls = 0;
  class Client {
    hostId = 'local'; requestPromises = new Map();
    async sendRequest(method, params, options) {
      assert.equal(method, 'account/rateLimits/read');
      assert.equal(params, undefined); assert.equal(options.priority, 'background');
      assert.equal(options.timeoutMs, 10000);
      calls++;
      return { rateLimits: { limitId: 'codex', primary: { windowDurationMins: 300, usedPercent: 40, resetsAt: 1 } } };
    }
  }
  const manager = { hostId: 'local', requestClient: new Client() };
  const ref = { current: manager };
  Object.defineProperty(ref, 'credentialGetter', { get() { throw Error('getter-called'); } });
  const root = { cache: Array.from({length:100010},()=>({nested:{}})),
    child: { memoizedState: { memoizedState: ref, next: null } } };
  globalThis.window = { __codexRoot: { _internalRoot: { current: root } } };
  try { assert.equal(readQuota(await readDesktopQuota()).remainingPercent, 60); assert.equal(calls, 1); }
  finally { delete globalThis.window; }
});
