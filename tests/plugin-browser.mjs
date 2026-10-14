import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.argv[2]);
const context=await chromium.launchPersistentContext(path.resolve('runtime/verification/plugin-browser-profile'),
  {executablePath:process.argv[3],headless:true,viewport:{width:900,height:380},timezoneId:'Asia/Hong_Kong',
    downloadsPath:path.resolve('runtime/verification/plugin-browser-downloads')});
const page=await context.newPage();const out=path.resolve('runtime/verification');await mkdir(out,{recursive:true});
const html=await readFile('plugin/panel.html','utf8');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const checks=[];
try{
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe style="border:0;width:100%;height:360px" title="会话状态"></iframe></body></html>');
  await page.evaluate(({html,A,B})=>{
    const frame=document.querySelector('iframe');window.current=A;window.polls=0;window.delay=0;
    window.snapshot=(id)=>({binding:{sessionId:id,source:'host-thread-metadata'},session:{value:{totalTokens:id===A?12000:90000,cacheHitPercent:id===A?80:25},stale:false},
      quota:{value:{remainingPercent:61,resetsAt:1791683809},updatedAt:Date.now(),stale:false},mode:{value:id===A?'Work':'Codex',stale:false}});
    window.notify=(method,params)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method,params},'*');
    window.addEventListener('message',async(event)=>{
      if(event.source!==frame.contentWindow||event.data?.jsonrpc!=='2.0'||!event.data.id)return;
      const message=event.data;
      if(message.method==='ui/initialize'){
        window.initParams=message.params;
        frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'light'}}},'*');
        setTimeout(()=>{window.notify('ui/notifications/tool-input',{arguments:{session_id:A}});window.notify('ui/notifications/tool-result',{structuredContent:window.snapshot(A)})},20);
      }else if(message.method==='tools/call'){
        window.polls++;const data=window.snapshot(window.current);const wait=window.delay;
        if(wait)await new Promise(r=>setTimeout(r,wait));
        frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result:{structuredContent:data}},'*');
      }
    });frame.srcdoc=html;
  },{html,A,B});
  const frame=page.frameLocator('iframe');
  await frame.locator('#mode').getByText('Work',{exact:true}).waitFor();
  assert.equal(await frame.locator('.metric').count(),5);assert.equal(await frame.locator('#cache').textContent(),'80.0%');
  assert.equal(await frame.locator('#remaining').textContent(),'61%');checks.push('five fields and Work binding');
  assert.deepEqual(await page.evaluate(()=>window.initParams.appCapabilities.availableDisplayModes),['inline','pip','fullscreen']);checks.push('MCP Apps handshake');
  const reset=await frame.locator('#reset').textContent();assert.match(reset,/10.*11.*09:56/);checks.push('local reset date and time');
  await page.screenshot({path:path.join(out,'plugin-light.png')});
  await page.evaluate(()=>window.notify('ui/notifications/host-context-changed',{theme:'dark'}));
  await frame.locator('html[data-theme=dark]').waitFor();await page.screenshot({path:path.join(out,'plugin-dark.png')});checks.push('host light/dark themes');
  await page.setViewportSize({width:280,height:380});
  const fits=await frame.locator('body').evaluate(node=>node.scrollWidth<=innerWidth);assert.ok(fits);
  await page.screenshot({path:path.join(out,'plugin-narrow.png')});checks.push('280px layout without horizontal overflow');
  await page.evaluate(({B})=>{window.current=B;window.notify('ui/notifications/tool-input',{arguments:{session_id:B}})}, {B});
  await frame.locator('#mode').getByText('Codex',{exact:true}).waitFor();assert.equal(await frame.locator('#cache').textContent(),'25.0%');checks.push('conversation switch changes usage and mode');
  await page.evaluate(({A})=>{window.current=A;window.notify('ui/notifications/tool-result',{structuredContent:window.snapshot(A)})},{A});
  assert.equal(await frame.locator('#mode').textContent(),'Codex');checks.push('late result from another conversation rejected');
  await frame.locator('#mode').getByText('Work',{exact:true}).waitFor({timeout:6000});checks.push('host-authoritative context rebind on poll');
  await page.evaluate(()=>{const data=window.snapshot(window.current);data.quota.stale=true;window.notify('ui/notifications/tool-result',{structuredContent:data})});
  await frame.locator('#remaining.stale').waitFor();assert.equal(await frame.locator('#remaining').textContent(),'61%');checks.push('failed quota preserves value and marks stale');
  await page.evaluate(()=>window.notify('ui/notifications/tool-input',{arguments:{}}));
  await frame.locator('#mode').getByText('未知',{exact:true}).waitFor();assert.equal(await frame.locator('#tokens').textContent(),'--');checks.push('unbound panel does not guess latest session');
  await page.emulateMedia({reducedMotion:'reduce'});
  await frame.locator('dd').evaluateAll(nodes=>nodes.forEach(node=>node.style.fontSize='24px'));assert.ok(await frame.locator('body').evaluate(node=>node.scrollWidth<=innerWidth));checks.push('text scaling and reduced motion');
  await page.evaluate(({A})=>window.notify('ui/notifications/tool-input',{arguments:{session_id:A}}),{A});
  await frame.locator('#mode').getByText('Work',{exact:true}).waitFor();
  await page.evaluate(()=>window.notify('ui/resource-teardown',{}));
  const before=await page.evaluate(()=>window.polls);await page.waitForTimeout(2300);assert.equal(await page.evaluate(()=>window.polls),before);checks.push('teardown stops background polling');
  await writeFile(path.join(out,'plugin-browser.json'),JSON.stringify({passed:checks.length,checks,nativeClient:false},null,2)+'\n');
  console.log('PASS: '+checks.length+' isolated plugin UI checks; native acceptance pending');
}finally{await context.close()}
