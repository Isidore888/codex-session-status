import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { installStatusRow } from '../src/renderer.mjs';
import { readQuota } from '../src/metrics.mjs';
import { CdpSession, listTargets } from '../src/cdp.mjs';
import { quotaExpression } from '../src/quota-bridge.mjs';
import { checkLifecycle } from './lifecycle-fixture.mjs';

const modulePath = process.argv[2];
const executablePath = process.argv[3];
if (!modulePath || !executablePath) throw new Error('Provide bundled playwright directory and Edge executable');
const require = createRequire(import.meta.url);
const { chromium } = require(modulePath);
const out = path.resolve('runtime', 'verification');
await mkdir(out, { recursive: true });
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const context = await chromium.launchPersistentContext(path.join(out, 'browser-profile'), {
  executablePath, headless: true, viewport: { width: 1000, height: 600 }, timezoneId: 'Asia/Hong_Kong',
  tracesDir: path.join(out, 'traces'), downloadsPath: path.join(out, 'downloads'),
  args: ['--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1'],
});
const browser = context.browser();
const page = context.pages()[0] || await context.newPage();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const html = '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'body{margin:0;background:#212121;color:#eee;font:14px Segoe UI,sans-serif}'
  + 'main{position:absolute;bottom:24px;left:24px;right:24px}'
  + '.ComposerLayoutRoot{display:flex;flex-direction:column;position:relative;border-radius:24px;background:#303030;padding:16px 12px 0}'
  + 'textarea{height:90px;resize:none;color:inherit;background:transparent;border:0;font:inherit}'
  + '.controls{display:flex;gap:16px;justify-content:space-between;padding-bottom:16px}'
  + 'button{padding:8px;color:inherit;background:transparent;border:1px solid #888;border-radius:12px}'
  + '</style></head><body><main data-thread-id="' + A + '"><div class="ComposerLayoutRoot">'
  + '<textarea placeholder="使用 ChatGPT Work"></textarea><div class="controls">'
  + '<button id="approval">帮我批准</button><button id="model">GPT-6.1 Sol 高</button>'
  + '<button id="send">发送</button></div></div></main></body></html>';
try {
  await page.setContent(html);
  await page.evaluate(() => {
    const composer=document.querySelector('.ComposerLayoutRoot');
    const stale={memoizedProps:{workThreadServiceName:null},stateNode:composer,return:null};
    composer.__reactFiber$fixture=stale;
    // Even a shared child's stale return must not override the committed path.
    window.__codexRoot={_internalRoot:{current:{memoizedProps:{isNativeWork:false,workThreadServiceName:'codex_work_desktop'},child:{stateNode:composer,return:stale}}}};
  });
  const originalComposer = await page.locator('.ComposerLayoutRoot').boundingBox();
  const originalField = await page.locator('textarea').boundingBox();
  await page.evaluate(installStatusRow);
  await page.evaluate(installStatusRow);
  assert.equal(await page.locator('.codex-session-status-row').count(), 1);
  const quota = { value: readQuota({ rateLimits: { limitId: 'codex',
    primary: { windowDurationMins: 300, usedPercent: 25, resetsAt: 1791659281 } } }), stale: false };
  const data = { sessions: { [A]: { value: { totalTokens: 12000, cacheHitPercent: 80 }, stale: false, mode: {value:'Work',stale:false},task:{value:{turnId:A,startedAt:1000,durationMs:65000,state:'completed'},stale:false} } }, quota };
  await page.evaluate((data) => window.__CODEX_SESSION_STATUS_V1__.update(data), data);
  const inspect = () => page.evaluate(() => window.__CODEX_SESSION_STATUS_V1__.inspect());
  assert.equal((await inspect())[0].values[1], '80.0%');
  assert.equal((await inspect())[0].values[2], '75%');
  assert.equal((await inspect())[0].values.length, 6);
  assert.equal((await inspect())[0].values[4], 'Work', 'saved identity follows the active UUID');
  assert.deepEqual((await inspect())[0].staleFields, []);
  assert.equal(await page.locator('.update-state,[title]').count(), 0, 'no hover hints or stale badge');
  assert.equal((await inspect())[0].values[5],'01:05');
  await page.evaluate(()=>{window.__originalNow=Date.now;window.__fixtureNow=66000;Date.now=()=>window.__fixtureNow;});
  data.sessions[A].task.value={turnId:A,startedAt:1000,durationMs:null,state:'running'};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[5],'01:05');
  await page.evaluate(()=>{window.__fixtureNow=67500;});
  assert.equal((await inspect())[0].values[5],'01:06','running duration increases');
  data.sessions[A].task.stale=true;
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  await page.evaluate(()=>{window.__fixtureNow=90000;});
  assert.equal((await inspect())[0].values[5],'01:06','failed reads freeze the last observed duration');
  assert.deepEqual((await inspect())[0].staleFields,[5]);
  // A stale clock belongs to its UUID/root turn, not the currently mounted DOM row.
  await page.evaluate(id=>document.querySelector('main').dataset.threadId=id,B);
  await page.evaluate(()=>{window.__fixtureNow=120000;});
  await page.evaluate(id=>document.querySelector('main').dataset.threadId=id,A);
  assert.equal((await inspect())[0].values[5],'01:06','stale clock survives an A/B/A session round trip');
  await page.evaluate(()=>{
    const old=document.querySelector('.ComposerLayoutRoot'),next=old.cloneNode(true);
    next.__reactFiber$fixture=old.__reactFiber$fixture;
    next.querySelector('.codex-session-status-row')?.remove();old.replaceWith(next);
    window.__fixtureNow=150000;
  });
  assert.equal((await inspect())[0].values[5],'01:06','stale clock survives a composer remount');
  assert.deepEqual((await inspect())[0].staleFields,[5]);
  data.sessions[A].task.value={turnId:B,startedAt:140000,durationMs:null,state:'running'};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[5],'—','a different stale root cannot inherit the previous root clock');
  data.sessions[A].task.stale=false;
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[5],'00:10','successful read resumes the new root clock');
  data.sessions[A].task={value:{turnId:A,startedAt:1000,durationMs:67000,state:'completed'},stale:false};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[5],'01:07');
  await page.evaluate(()=>{window.__fixtureNow=200000;});
  assert.equal((await inspect())[0].values[5],'01:07','completed duration is frozen');
  data.sessions[A].task.value={turnId:B,startedAt:200000,durationMs:null,state:'running'};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[5],'00:00','next task resets the clock');
  await page.evaluate(()=>{Date.now=window.__originalNow;delete window.__originalNow;delete window.__fixtureNow;});
  data.sessions[A].task={value:{turnId:A,startedAt:1000,durationMs:65000,state:'completed'},stale:false};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal(await page.locator('.label').first().textContent(), '累计Token');
  assert.equal(await page.locator('.label').nth(2).textContent(), '5小时剩余');
  assert.equal(await page.locator('.label').nth(4).textContent(), '执行模式');
  await page.evaluate(() => {window.__codexRoot._internalRoot.current.memoizedProps.workThreadServiceName=null;});
  assert.equal((await inspect())[0].values[4], 'Work', 'changing product view does not change the saved working identity');
  assert.equal((await inspect())[0].values[0], '1.2万');
  await page.evaluate(() => {
    window.__statusFixtureRoot=window.__codexRoot._internalRoot.current;
    let tail={stateNode:document.querySelector('.ComposerLayoutRoot')};
    for(let i=0;i<24000;i++)tail={sibling:tail};
    window.__codexRoot._internalRoot.current={memoizedProps:{workThreadServiceName:'codex_work_desktop'},child:tail};
  });
  assert.equal((await inspect())[0].values[4], 'Work', 'large UI trees do not override a bound working identity');
  await page.evaluate(() => { window.__codexRoot._internalRoot.current=window.__statusFixtureRoot;delete window.__statusFixtureRoot; });
  assert.equal((await inspect())[0].tokenTotal,12000);
  assert.equal((await inspect())[0].values[3], '03:08');
  for (const [tokens, expected] of [[58_205_078,'5820.5万'],[152_345_000,'1亿5234.5万'],[100_000_000,'1亿'],[100_010_000,'1亿1万'],[99_999_500,'1亿'],[1_199_999_999_500,'1万亿2000亿'],[1_200_000_000_000,'1万亿2000亿']]) {
    data.sessions[A].value.totalTokens=tokens;
    await page.evaluate((data)=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
    assert.equal((await inspect())[0].values[0],expected);
  }
  data.sessions[A].value.totalTokens=58_205_078;
  await page.evaluate((data)=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  const assertGeometry = async () => {
    const row = await page.locator('.codex-session-status-row').boundingBox();
    const field = await page.locator('textarea').boundingBox();
    assert.ok(row.y >= field.y + field.height);
    for (const id of ['approval', 'model', 'send']) {
      const control = await page.locator('#' + id).boundingBox();
      assert.ok(row.y >= control.y + control.height);
    }
    assert.ok(row.x >= 0 && row.x + row.width <= (await page.viewportSize()).width);
  };
  await assertGeometry();
  const compactRow = await page.locator('.codex-session-status-row').boundingBox();
  const compactComposer = await page.locator('.ComposerLayoutRoot').boundingBox();
  const compactField = await page.locator('textarea').boundingBox();
  assert.equal(compactComposer.width, originalComposer.width, 'status row cannot enlarge composer width');
  assert.equal(compactField.height, originalField.height, 'status row cannot resize the typing area');
  assert.ok(compactRow.height <= 20, 'wide composer uses one compact line');
  assert.ok(compactComposer.height - originalComposer.height <= 24, 'extra composer height stays compact');
  const commit = await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{
    const old=document.querySelector('.ComposerLayoutRoot');
    const before=old.getBoundingClientRect().height;
    const next=old.cloneNode(true);next.__reactFiber$fixture=old.__reactFiber$fixture;
    next.querySelector('.codex-session-status-row').remove();old.replaceWith(next);
    queueMicrotask(()=>resolve({before,after:next.getBoundingClientRect().height,rows:next.querySelectorAll('.codex-session-status-row').length}));
  })));
  assert.equal(commit.rows,1,'composer commit is repaired before the next animation frame');
  assert.equal(commit.after,commit.before,'submit/remount cannot temporarily collapse composer height');
  const detachedRow = await page.evaluate(()=>new Promise(resolve=>{
    const host=document.querySelector('.codex-session-status-row');host.remove();
    queueMicrotask(()=>resolve(document.querySelector('.codex-session-status-row')===host));
  }));
  assert.equal(detachedRow,true,'native child replacement reattaches the same status host before paint');
  const remountGap = await page.evaluate(async()=>{
    const api=window.__CODEX_SESSION_STATUS_V1__;
    const main=document.querySelector('main'),old=document.querySelector('.ComposerLayoutRoot');
    const host=old.querySelector('.codex-session-status-row'),before=api.inspect()[0].values;
    const next=old.cloneNode(true);next.__reactFiber$fixture=old.__reactFiber$fixture;
    next.querySelector('.codex-session-status-row').remove();
    old.remove();await new Promise(queueMicrotask);
    api.update({sessions:{},quota:{value:{remainingPercent:75,resetsAt:1791659281},stale:false}});
    const hiddenContexts=api.contexts();
    main.append(next);await new Promise(queueMicrotask);
    const after=api.inspect()[0].values;
    return {sameHost:next.querySelector('.codex-session-status-row')===host,before,after,hiddenContexts};
  });
  assert.equal(remountGap.sameHost,true,'same UUID reuses the actual status host across a native composer gap');
  assert.deepEqual(remountGap.after,remountGap.before,'empty active-context round cannot clear same-UUID metrics');
  assert.deepEqual(remountGap.hiddenContexts,[],'retained DOM/data cannot expose an inactive UUID as active');
  const noCrossReuse=await page.evaluate(async()=>{
    const api=window.__CODEX_SESSION_STATUS_V1__,main=document.querySelector('main');
    const old=document.querySelector('.ComposerLayoutRoot'),host=old.querySelector('.codex-session-status-row');
    const next=old.cloneNode(true);next.__reactFiber$fixture=old.__reactFiber$fixture;
    next.querySelector('.codex-session-status-row').remove();old.remove();await new Promise(queueMicrotask);
    main.dataset.threadId='33333333-3333-4333-8333-333333333333';main.append(next);await new Promise(queueMicrotask);
    const result={sameHost:next.querySelector('.codex-session-status-row')===host,values:api.inspect()[0].values};
    main.dataset.threadId='11111111-1111-4111-8111-111111111111';await new Promise(queueMicrotask);
    return result;
  });
  assert.equal(noCrossReuse.sameHost,false,'a new UUID cannot reuse another conversation status host');
  assert.equal(noCrossReuse.values[0],'—');assert.equal(noCrossReuse.values[4],'未知');assert.equal(noCrossReuse.values[5],'—');
  const emptySource=structuredClone(data);
  emptySource.sessions[A]={value:null,stale:false,mode:{value:null,stale:false},task:{value:null,stale:false}};
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),emptySource);
  assert.equal((await inspect())[0].values[0],'—','explicit successful empty source replaces retained data');
  assert.equal((await inspect())[0].values[5],'—');
  await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  await page.screenshot({ path: path.join(out, 'status-dark.png') });
  await page.evaluate(() => { document.body.style.background = '#fff'; document.body.style.color = '#222';
    document.querySelector('.ComposerLayoutRoot').style.background = '#f5f5f5'; });
  await page.screenshot({ path: path.join(out, 'status-light.png') });
  await page.setViewportSize({ width: 380, height: 600 });
  await assertGeometry();
  await page.screenshot({ path: path.join(out, 'status-narrow.png') });
  await page.evaluate((id) => document.querySelector('main').setAttribute('data-thread-id', id), B);
  await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__.inspect()[0].threadId
    === '22222222-2222-4222-8222-222222222222');
  assert.equal((await inspect())[0].values[0], '—');
  assert.equal((await inspect())[0].values[5], '—','new UUID cannot inherit another task duration');
  assert.equal((await inspect())[0].values[4], '未知', 'new UUID must not inherit another session or the current product view');
  data.sessions[B] = { value: { totalTokens: 1, cacheHitPercent: null }, stale: true, mode:{value:'Codex',stale:true} };
  data.quota.stale = true;
  await page.evaluate((data) => window.__CODEX_SESSION_STATUS_V1__.update(data), data);
  assert.equal((await inspect())[0].values[0], '1');
  assert.equal((await inspect())[0].values[2], '75%');
  assert.equal((await inspect())[0].values[4], 'Codex', 'failed reads retain only the bound identity; stale state is explicit metadata');
  assert.deepEqual((await inspect())[0].staleFields, [0,1,2,3,4], 'unchanged values cannot hide stale state from acceptance');
  assert.equal(await page.locator('.update-state,[title]').count(),0,'stale data adds no badge or hover hint');
  assert.match(await page.locator('.metric').nth(1).getAttribute('aria-label'),/未更新/);
  assert.ok((await inspect())[0].values.every((value) => !value.includes('未更新')));
  // Reproduce the user's quota-only missing state in a native-width fixture.
  const allStale = structuredClone(data);
  data.sessions[B] = { value: {totalTokens:150_000_000,cacheHitPercent:96.8},stale:false,mode:{value:'Work',stale:false} };
  data.quota = {value:null,stale:true};
  await page.evaluate((data) => window.__CODEX_SESSION_STATUS_V1__.update(data), data);
  assert.deepEqual((await inspect())[0].staleFields, [2,3]);
  assert.deepEqual((await inspect())[0].values, ['1亿5000万','96.8%','—','—','Work','—']);
  assert.equal(await page.locator('.metric.stale').count(), 2);
  assert.equal(await page.locator('.update-state,[title]').count(),0);
  await page.setViewportSize({width:760,height:600});
  await assertGeometry();
  assert.ok((await page.locator('.codex-session-status-row').boundingBox()).height <= 20, 'quota failure stays one compact line at native width');
  await page.evaluate(() => { document.body.style.background='#212121';document.body.style.color='#eee';document.querySelector('.ComposerLayoutRoot').style.background='#303030'; });
  await page.screenshot({path:path.join(out,'status-dark-v18.png')});
  await page.evaluate(() => { document.body.style.background='#fff';document.body.style.color='#222';document.querySelector('.ComposerLayoutRoot').style.background='#f5f5f5'; });
  await page.screenshot({path:path.join(out,'status-light-v18.png')});
  await page.setViewportSize({width:380,height:600});
  await assertGeometry();
  await page.screenshot({path:path.join(out,'status-narrow-v18.png')});
  data.quota = structuredClone(quota); data.quota.stale=false;
  await page.evaluate((data) => window.__CODEX_SESSION_STATUS_V1__.update(data), data);
  assert.equal(await page.locator('.metric.stale').count(),0,'recovery clears dimmed state immediately');
  assert.deepEqual((await inspect())[0].staleFields,[]);
  Object.assign(data,allStale);
  await page.evaluate((data) => window.__CODEX_SESSION_STATUS_V1__.update(data), data);
  await page.evaluate(() => {
    const old=window.__codexRoot._internalRoot.current;
    window.__codexRoot._internalRoot.current={memoizedProps:{isNativeWork:true,workThreadServiceName:null},child:old.child,alternate:old};
    document.querySelector('.ComposerLayoutRoot').__reactFiber$fixture.memoizedProps.workThreadServiceName='codex_work_desktop';
  });
  assert.equal((await inspect())[0].values[4], 'Codex');
  await page.evaluate(() => { window.__codexRoot._internalRoot.current.child.memoizedProps={workThreadServiceName:'codex_work_desktop'}; });
  assert.equal((await inspect())[0].values[4], 'Codex', 'conflicting UI flags cannot reclassify the saved identity');
  await page.evaluate(() => { delete window.__codexRoot._internalRoot.current.memoizedProps.workThreadServiceName;delete window.__codexRoot._internalRoot.current.child.memoizedProps.workThreadServiceName; });
  assert.equal((await inspect())[0].values[4], 'Codex', 'missing UI metadata does not erase the saved identity');
  await page.evaluate(() => {window.__codexRoot._internalRoot.current.memoizedProps.workThreadServiceName='future_service';});
  assert.equal((await inspect())[0].values[4], 'Codex', 'UI metrics service does not reclassify the saved identity');
  await page.evaluate(() => {window.__codexRoot._internalRoot.current.memoizedProps.workThreadServiceName='codex_work_desktop';Object.defineProperty(window.__codexRoot._internalRoot.current.child.memoizedProps,'workThreadServiceName',{configurable:true,get(){throw Error('service-getter-must-not-run')}});});
  assert.equal((await inspect())[0].values[4], 'Codex', 'UI accessors cannot reclassify the saved identity');
  await page.evaluate(() => {delete window.__codexRoot._internalRoot.current.child.memoizedProps.workThreadServiceName;window.__modeGetterCalls=0;Object.defineProperty(window.__codexRoot._internalRoot.current,'memoizedProps',{get(){window.__modeGetterCalls++;throw Error('mode-getter-must-not-run')}});});
  assert.equal((await inspect())[0].values[4], 'Codex', 'identity display never invokes app getters');
  assert.equal(await page.evaluate(()=>window.__modeGetterCalls),0);
  data.sessions[B].mode={value:null,stale:false};
  await page.evaluate((data)=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[4], '未知', 'missing or conflicting saved identity stays unknown');
  data.sessions[B].mode={value:'future_kind',stale:false};
  await page.evaluate((data)=>window.__CODEX_SESSION_STATUS_V1__.update(data),data);
  assert.equal((await inspect())[0].values[4], '未知', 'unrecognized saved identity stays unknown');
  await page.evaluate(() => {
    const old = document.querySelector('.ComposerLayoutRoot');
    const replacement = old.cloneNode(true);
    replacement.querySelector('.codex-session-status-row')?.remove();
    old.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelectorAll('.codex-session-status-row').length === 1);
  assert.equal((await inspect()).length, 1);
  await page.evaluate(() => window.__CODEX_SESSION_STATUS_V1__.dispose());
  assert.equal(await page.locator('.codex-session-status-row').count(), 0);
  // Native draft shape: a transparent root and a rounded, painted body.
  await page.setContent(html);
  await page.evaluate(() => {
    const root=document.querySelector('.ComposerLayoutRoot');
    const body=document.createElement('div');body.className='ComposerLayoutBody';
    body.style.cssText='display:flex;flex-direction:column;background:#303030;border-radius:22px';
    body.append(...root.childNodes);root.append(body);root.style.background='transparent';
    document.querySelector('main').removeAttribute('data-thread-id');
  });
  await page.evaluate(installStatusRow);
  await assertGeometry();
  assert.equal(await page.locator('.ComposerLayoutBody > .codex-session-status-row').count(),1);
  assert.equal((await inspect())[0].values[0],'—','draft does not inherit an existing session');
  const draftBody=await page.locator('.ComposerLayoutBody').boundingBox();
  const draftRow=await page.locator('.codex-session-status-row').boundingBox();
  assert.ok(draftRow.y+draftRow.height <= draftBody.y+draftBody.height,'row stays inside draft background');
  await page.evaluate(()=>{
    document.body.style.fontFamily='serif';document.body.style.setProperty('--text-button-composer','16px');
    document.body.style.setProperty('--line-height-button-composer','22px');
  });
  const font=await page.locator('.metrics').evaluate(n=>{
    const s=getComputedStyle(n);return {family:s.fontFamily,size:s.fontSize,line:s.lineHeight};
  });
  assert.deepEqual(font,{family:'serif',size:'16px',line:'22px'},'font settings flow through shadow DOM immediately');
  await assertGeometry();
  await page.screenshot({path:path.join(out,'status-draft.png')});
  await page.evaluate(data=>{document.querySelector('main').dataset.threadId='11111111-1111-4111-8111-111111111111';window.__CODEX_SESSION_STATUS_V1__.update(data);},data);
  const bodyGap=await page.evaluate(async()=>{
    const composer=document.querySelector('.ComposerLayoutRoot'),body=composer.querySelector('.ComposerLayoutBody');
    const oldField=body.querySelector('textarea'),field=document.createElement('div');
    field.contentEditable='true';field.style.cssText='display:block;height:90px';oldField.replaceWith(field);
    await new Promise(queueMicrotask);
    const host=body.querySelector('.codex-session-status-row'),height=body.getBoundingClientRect().height;
    const before=window.__CODEX_SESSION_STATUS_V1__.inspect()[0].values;
    let ownMutations=0;const observer=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes])if(node===host)ownMutations++;});
    observer.observe(body,{childList:true,subtree:true});
    field.contentEditable='false';field.replaceChildren(document.createElement('br'));
    await new Promise(resolve=>setTimeout(resolve,220));
    const during={sameHost:body.querySelector('.codex-session-status-row')===host,height:body.getBoundingClientRect().height,rows:window.__CODEX_SESSION_STATUS_V1__.inspect()};
    field.contentEditable='true';await new Promise(queueMicrotask);
    const after=body.querySelector('.codex-session-status-row')===host;
    observer.disconnect();
    field.contentEditable='false';body.className='UnknownBody';body.append(document.createComment('native-commit'));
    await new Promise(queueMicrotask);const unknown=window.__CODEX_SESSION_STATUS_V1__.inspect().length;
    body.className='ComposerLayoutBody';field.contentEditable='true';window.__CODEX_SESSION_STATUS_V1__.inspect();
    field.contentEditable='false';body.style.background='transparent';body.append(document.createComment('native-commit'));
    await new Promise(queueMicrotask);const unpainted=window.__CODEX_SESSION_STATUS_V1__.inspect().length;
    body.style.background='#303030';field.contentEditable='true';window.__CODEX_SESSION_STATUS_V1__.inspect();
    return {height,before,during,after,ownMutations,unknown,unpainted};
  });
  assert.equal(bodyGap.during.sameHost,true,'transparent shell retains its verified painted body row throughout editor gap');
  assert.equal(bodyGap.during.height,bodyGap.height);assert.equal(bodyGap.during.rows.length,1);
  assert.deepEqual(bodyGap.during.rows[0].values,bodyGap.before);assert.equal(bodyGap.after,true);assert.equal(bodyGap.ownMutations,0);
  assert.equal(bodyGap.unknown,0,'unrecognized original body cannot retain a row');assert.equal(bodyGap.unpainted,0,'unpainted original body cannot retain a row');
  // The same native root may acquire a background as its layout changes.
  await page.evaluate(()=>{document.querySelector('.ComposerLayoutRoot').style.background='#303030';window.__CODEX_SESSION_STATUS_V1__.inspect();});
  assert.equal(await page.locator('.ComposerLayoutRoot > .codex-session-status-row').count(),1);
  assert.equal(await page.locator('.codex-session-status-row').count(),1);
  await page.evaluate(()=>window.__CODEX_SESSION_STATUS_V1__.dispose());
  // The real client keeps separate native pages mounted and flips their visibility.
  const nativePages=html.replace(/<main[\s\S]*<\/main>/,'<style>[data-app-shell-active-page="false"]{display:none}</style>'
    +'<div data-thread-id="'+A+'"><section data-app-shell-active-page="false" id="page-a">'+html.match(/<main[\s\S]*<\/main>/)[0]+'</section>'
    +'<section data-app-shell-active-page="true" id="page-b">'+html.match(/<main[\s\S]*<\/main>/)[0].replace(A,B)+'</section>'
    +'<section data-app-shell-active-page="false" id="page-unknown"><div class="ComposerLayoutRoot" style="display:flex;flex-direction:column;background:#303030"><textarea placeholder="使用 ChatGPT Work"></textarea></div></section></div>');
  await page.setContent(nativePages);
  await page.evaluate(installStatusRow);
  const pageData={sessions:{[A]:{value:{totalTokens:12000,cacheHitPercent:80},stale:false,mode:{value:'Work',stale:false},task:{value:{turnId:A,startedAt:1000,durationMs:65000},stale:false}},
    [B]:{value:{totalTokens:24000,cacheHitPercent:90},stale:false,mode:{value:'Codex',stale:false},task:{value:{turnId:B,startedAt:1000,durationMs:70000},stale:false}}},quota:structuredClone(quota)};
  const prewarm=await page.evaluate(data=>window.__CODEX_SESSION_STATUS_V1__.update(data),pageData);
  assert.equal(prewarm.rows,1,'hidden prepared rows do not count as visible UI');
  assert.deepEqual(prewarm.contexts,[B]);
  assert.deepEqual(await page.evaluate(()=>window.__CODEX_SESSION_STATUS_V1__.readContexts().sort()),[A,B]);
  assert.equal(await page.locator('.codex-session-status-row').count(),2,'both UUID-bound native pages are prepared');
  assert.equal(await page.locator('#page-unknown .codex-session-status-row').count(),0,'hidden page cannot borrow an ancestor/outside UUID');
  const pageSwap=await page.evaluate(async()=>{
    const hosts=[...document.querySelectorAll('.codex-session-status-row')];let ownMutations=0;
    const obs=new MutationObserver(records=>{for(const r of records)for(const n of [...r.addedNodes,...r.removedNodes])if(n.nodeType===1&&(n.matches('.codex-session-status-row')||n.querySelector('.codex-session-status-row')))ownMutations++;});
    obs.observe(document.documentElement,{childList:true,subtree:true});
    const a=document.querySelector('#page-a'),b=document.querySelector('#page-b');
    b.dataset.appShellActivePage='false';a.dataset.appShellActivePage='true';await new Promise(queueMicrotask);
    const first=window.__CODEX_SESSION_STATUS_V1__.inspect();
    a.dataset.appShellActivePage='false';b.dataset.appShellActivePage='true';await new Promise(queueMicrotask);
    const second=window.__CODEX_SESSION_STATUS_V1__.inspect();
    const sameHosts=hosts.every(h=>h.isConnected);obs.disconnect();return {first,second,sameHosts,ownMutations};
  });
  assert.equal(pageSwap.ownMutations,0,'native page visibility changes cannot detach/recreate status hosts');
  assert.equal(pageSwap.sameHosts,true);
  assert.equal(pageSwap.first.length,1);assert.equal(pageSwap.first[0].threadId,A);assert.equal(pageSwap.first[0].values[4],'Work');
  assert.equal(pageSwap.second.length,1);assert.equal(pageSwap.second[0].threadId,B);assert.equal(pageSwap.second[0].values[4],'Codex');
  const hiddenField=await page.evaluate(()=>{document.querySelector('#page-b textarea').style.display='none';return window.__CODEX_SESSION_STATUS_V1__.inspect();});
  assert.equal(hiddenField.length,1,'temporary hidden editor does not delete an already verified status surface');
  assert.equal(hiddenField[0].values[0],'2.4万');
  const idleGap=await page.evaluate(async()=>{
    const composer=document.querySelector('#page-b .ComposerLayoutRoot');
    const oldField=composer.querySelector('textarea');
    const field=document.createElement('div');field.contentEditable='true';field.style.cssText='display:block;height:64px';oldField.replaceWith(field);
    await new Promise(queueMicrotask);
    const host=composer.querySelector('.codex-session-status-row'),height=composer.getBoundingClientRect().height;
    let ownMutations=0;
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes])if(node===host)ownMutations++;});
    observer.observe(composer,{childList:true,subtree:true});
    field.contentEditable='false';field.replaceChildren(document.createElement('br'));
    await new Promise(resolve=>setTimeout(resolve,220));
    const during={sameHost:composer.querySelector('.codex-session-status-row')===host,height:composer.getBoundingClientRect().height,rows:window.__CODEX_SESSION_STATUS_V1__.inspect()};
    field.contentEditable='true';await new Promise(queueMicrotask);
    const after={sameHost:composer.querySelector('.codex-session-status-row')===host,rows:window.__CODEX_SESSION_STATUS_V1__.inspect()};
    observer.disconnect();return {during,after,height,ownMutations};
  });
  assert.equal(idleGap.during.sameHost,true,'same native composer/UUID retains the existing row throughout an editor gap');
  assert.equal(idleGap.during.height,idleGap.height,'editor gap cannot collapse status row space');
  assert.equal(idleGap.during.rows.length,1);assert.equal(idleGap.during.rows[0].threadId,B);assert.equal(idleGap.during.rows[0].values[0],'2.4万');
  assert.equal(idleGap.after.sameHost,true);assert.equal(idleGap.ownMutations,0,'idle submit gap cannot remove/reinsert the status row');
  const gapUuidChange=await page.evaluate(async()=>{
    const composer=document.querySelector('#page-b .ComposerLayoutRoot'),field=composer.querySelector('[contenteditable="true"]');
    field.contentEditable='false';await new Promise(queueMicrotask);
    document.querySelector('#page-b main').dataset.threadId='';await new Promise(queueMicrotask);
    const unknownRows=composer.querySelectorAll('.codex-session-status-row').length;
    document.querySelector('#page-b main').dataset.threadId='11111111-1111-4111-8111-111111111111';await new Promise(queueMicrotask);
    const withoutFieldRows=composer.querySelectorAll('.codex-session-status-row').length;
    field.contentEditable='true';await new Promise(queueMicrotask);
    const changed=window.__CODEX_SESSION_STATUS_V1__.inspect();
    return {unknownRows,withoutFieldRows,changed};
  });
  assert.equal(gapUuidChange.unknownRows,0,'missing UUID during editor gap cannot keep the old conversation visible');
  assert.equal(gapUuidChange.withoutFieldRows,0,'a different UUID without an editor cannot reuse a verified row');
  assert.equal(gapUuidChange.changed.length,1);assert.equal(gapUuidChange.changed[0].threadId,A);assert.equal(gapUuidChange.changed[0].values[4],'Work');
  await page.evaluate(()=>window.__CODEX_SESSION_STATUS_V1__.dispose());
  assert.equal(await page.locator('.codex-session-status-row').count(),0,'dispose removes hidden and visible native-page rows');
  await page.setContent(html);
  await page.evaluate(installStatusRow);
  assert.equal((await inspect()).length, 1);
  // Exercise the tool's actual loopback WebSocket transport, not Playwright's CDP wrapper.
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const target = pages.find((item) => item.type === 'page' && item.url === 'about:blank');
  assert.ok(target);
  assert.equal((await listTargets(port)).length, 0, 'ordinary browser targets must be excluded');
  const transport = await CdpSession.connect(target.webSocketDebuggerUrl);
  let notifications = 0;
  try {
    transport.onContextChange = () => notifications++;
    await transport.send('Runtime.addBinding', { name: '__codexSessionStatusChanged' });
    await transport.evaluate("document.querySelector('main').dataset.threadId = '" + B + "'");
    await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__.inspect()[0].threadId
      === '22222222-2222-4222-8222-222222222222');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notifications, 1, 'thread change must immediately notify the monitor');
    await transport.evaluate("window.__codexRoot = { _internalRoot: { current: { client: {"
      + "hostId:'local',requestPromises:new Map(),sendRequest:async function(method){"
      + "if(method!=='account/rateLimits/read')throw Error('unexpected-method');"
      + "return {rateLimits:{limitId:'codex',primary:{windowDurationMins:300,usedPercent:25,resetsAt:1791659281}}};}"
      + "} } } }");
    assert.equal(readQuota(await transport.evaluate(quotaExpression)).remainingPercent, 75);
    await assert.rejects(transport.evaluate("throw Error('fixture-error')"), /renderer-evaluation-failed/);
    await assert.rejects(transport.evaluate("new Promise(()=>{})", 100), /cdp-timeout/);
    assert.equal(await transport.evaluate('2+2'), 4, 'transport recovers after request timeout');
    await page.evaluate(() => {
      window.__CODEX_SESSION_STATUS_V1__.dispose();
      document.querySelector('.ComposerLayoutRoot').style.display = 'block';
    });
    await transport.evaluate('(' + installStatusRow.toString() + ')()');
    assert.equal(await page.locator('.codex-session-status-row').count(), 0, 'unknown layouts must be untouched');
  } finally { transport.close(); }
  const native = await context.newCDPSession(page);
  const value = await native.send('Browser.getVersion');
  assert.ok(value.product);
  await writeFile(path.join(out, 'browser-results.json'), JSON.stringify({
    passed: true, cases: ['duplicate-install', 'six-metrics', 'local-reset-time', 'dark-light',
      'narrow-geometry', 'thread-switch', 'stale-data', 'composer-replacement', 'dispose', 'reload',
      'loopback-websocket', 'immediate-thread-notification', 'authenticated-channel-fixture',
      'request-timeout-recovery', 'unsupported-layout', 'uuid-bound-working-identity', 'no-ui-reclassification',
      'draft-painted-body', 'dynamic-native-font-settings', 'surface-change-single-row',
      'no-hover-or-badge','explicit-stale-metadata','quota-missing-dark-light-narrow','stale-clears-on-recovery',
      'integer-yi-one-decimal-wan-carry','task-running-frozen-reset-stale','task-uuid-isolation',
      'stale-clock-session-roundtrip-remount','stale-new-root-no-inheritance','composer-commit-before-paint','detached-host-reuse',
      'same-uuid-host-data-remount-gap','retained-inactive-context-not-exposed','new-uuid-no-host-inheritance','explicit-empty-source-clears-cache',
      'native-hidden-page-prewarm','page-boundary-no-uuid-borrow','page-swap-no-row-mutations','active-only-inspection','temporary-hidden-editor-row-retained','dispose-all-native-pages',
      'idle-editor-gap-same-host-space-values','idle-editor-gap-no-row-mutations','idle-editor-gap-uuid-change-isolation',
      'transparent-body-editor-gap-host-values-space','transparent-body-editor-gap-no-mutations','invalid-original-body-withdrawal'],
    clientAcceptance: 'pending', browser: value.product,
  }, null, 2));
  console.log('PASS: browser UI acceptance (isolated fixture; real Codex pending)');
  if (process.argv.includes('--lifecycle')) {
    await checkLifecycle({ page, context, browserPort: port, html, out, A, B });
  }
} finally { await context.close(); }
