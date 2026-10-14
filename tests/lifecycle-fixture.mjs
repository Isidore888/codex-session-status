import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runMonitor, control, runtime } from '../src/monitor.mjs';

// A loopback proxy gives an isolated test page the native discovery metadata.
// No endpoint or message from the real Codex client participates in this fixture.
export async function checkLifecycle({ page, context, browserPort, html, out, A, B }) {
  assert.equal(await control('health'), null, 'do not interfere with an existing monitor');
  await page.evaluate(() => window.__CODEX_SESSION_STATUS_V1__?.dispose());
  await page.setContent(html);
  const bindNativeMode = () => page.evaluate(() => {
    const client=window.__codexRoot?._internalRoot?.current?.client;
    window.__codexRoot={_internalRoot:{current:{client,memoizedProps:{isNativeWork:false,workThreadServiceName:'codex_work_desktop'},child:{stateNode:document.querySelector('.ComposerLayoutRoot')}}}};
  });
  await bindNativeMode();
  const root = path.join(out, 'fixtures');
  await mkdir(root, { recursive: true });
  const sessionsRoot = await mkdtemp(path.join(root, 'sessions-'));
  for (const [id, total] of [[A, 12000], [B, 24000]]) {
    await writeFile(path.join(sessionsRoot, id + '.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id,originator:id===A?'codex_work_desktop':'Codex Desktop' } }) + '\n' +
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-10T12:00:00Z',
        payload: { type: 'token_count', info: { total_token_usage: {
          total_tokens: total, input_tokens: 100, cached_input_tokens: 80 } } } }) + '\n');
  }
  const sockets = new Set();
  const proxy = http.createServer(async (request, response) => {
    try {
      const native = await (await fetch('http://127.0.0.1:' + browserPort + '/json/list',
        { signal: AbortSignal.timeout(1000) })).json();
      const port = proxy.address().port;
      const targets = native.filter((item) => item.type === 'page').map((item) => ({
        id: item.id, type: 'page', url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + new URL(item.webSocketDebuggerUrl).pathname,
      }));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(targets));
    } catch { response.writeHead(503); response.end('{}'); }
  });
  proxy.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const upstream = net.connect(browserPort, '127.0.0.1', () => {
      const headers = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index];
        const value = name.toLowerCase() === 'host' ? '127.0.0.1:' + browserPort : request.rawHeaders[index + 1];
        headers.push(name + ': ' + value);
      }
      upstream.write('GET ' + request.url + ' HTTP/1.1\r\n' + headers.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = proxy.address().port;
  let running = null;
  try {
    // Initial mounted page can precede its authenticated native request manager.
    // The status tool must retry after readiness, rather than wait a full minute.
    await page.evaluate(()=>{
      const client=window.__codexRoot._internalRoot.current.client;
      delete window.__codexRoot._internalRoot.current.client;
      setTimeout(()=>{window.__codexRoot._internalRoot.current.client=client;},600);
    });
    const attachedAt=Date.now();
    running = runMonitor({ port, sessionsRoot });
    await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__?.inspect()[0]?.values[2] === '75%',
      null, { timeout: 10000 });
    assert.ok(Date.now()-attachedAt < 5000,'late request manager is retried promptly and shown immediately');
    assert.equal((await control('health')).rows, 1);
    await runMonitor({ port, sessionsRoot });
    assert.equal(await page.locator('.codex-session-status-row').count(), 1);
    const beforeSwitch = Date.now();
    await page.evaluate((id) => {document.querySelector('main').dataset.threadId=id;window.__codexRoot._internalRoot.current.memoizedProps.workThreadServiceName=null;}, B);
    await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__?.inspect()[0]?.values[0] === '2.4万');
    assert.equal((await page.evaluate(()=>window.__CODEX_SESSION_STATUS_V1__.inspect()))[0].values[4],'Codex','switch follows the new UUID working identity');
    assert.ok(Date.now() - beforeSwitch < 1500, 'switch must wake the two-second loop immediately');
    await page.evaluate(() => window.__CODEX_SESSION_STATUS_V1__?.dispose());
    await page.setContent(html);
    await bindNativeMode();
    await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__?.inspect()[0]?.values[0] === '1.2万',
      null, { timeout: 10000 });
    assert.equal((await page.evaluate(()=>window.__CODEX_SESSION_STATUS_V1__.inspect()))[0].values[4],'Work','reload restores the saved identity of this UUID');
    const monitorBeforeGap=await readFile(path.join(runtime,'state.json'),'utf8');
    await page.evaluate(()=>{document.querySelector('.ComposerLayoutRoot').style.display='grid';});
    await page.waitForFunction(()=>window.__CODEX_SESSION_STATUS_V1__?.compatibility()==='unsupported');
    await new Promise(resolve=>setTimeout(resolve,4500));
    assert.equal(await page.locator('.codex-session-status-row').count(),0,'unknown layout must remain untouched');
    assert.equal((await control('health'))?.ok,true,'unknown UI must not terminate the connected monitor');
    await page.evaluate(()=>{document.querySelector('.ComposerLayoutRoot').style.display='flex';});
    await page.waitForFunction(()=>window.__CODEX_SESSION_STATUS_V1__?.inspect()[0]?.values[0]==='1.2万',null,{timeout:8000});
    assert.equal(await readFile(path.join(runtime,'state.json'),'utf8'),monitorBeforeGap,'valid layout recovers in the same monitor');
    assert.equal((await control('stop')).ok, true);
    await running;
    running = null;
    assert.equal(await page.locator('.codex-session-status-row').count(), 0);
    assert.equal(await control('health'), null);
    // Cold native startup can take longer than the runtime incompatibility grace.
    await page.evaluate(()=>{
      const client=window.__codexRoot._internalRoot.current.client;
      delete window.__codexRoot._internalRoot.current.client;
      setTimeout(()=>{window.__codexRoot._internalRoot.current.client=client;},35000);
    });
    const slowStartupAt=Date.now();
    running=runMonitor({port,sessionsRoot});
    await new Promise(resolve=>setTimeout(resolve,33000));
    assert.equal((await control('health'))?.ok,true,'valid cold startup must survive the 30-second runtime threshold');
    await page.waitForFunction(()=>window.__CODEX_SESSION_STATUS_V1__?.inspect()[0]?.values[2]==='75%',null,{timeout:35000});
    assert.ok(Date.now()-slowStartupAt<68000,'slow startup recovers within bounded retry schedule');
    assert.equal((await control('stop')).ok,true);
    await running;
    running=null;
    running = runMonitor({ port, sessionsRoot });
    await page.waitForFunction(() => window.__CODEX_SESSION_STATUS_V1__?.inspect().length === 1);
    await context.close();
    const exitedAt = Date.now();
    await Promise.race([running, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('orphan-monitor-after-client-exit')), 36000).unref())]);
    running = null;
    assert.ok(Date.now() - exitedAt >= 29000, 'reload grace period must be respected');
    assert.equal(await control('health'), null);
    await writeFile(path.join(out, 'lifecycle-results.json'), JSON.stringify({
      passed: true, cases: ['first-attach', 'repeat-singleton', 'immediate-session-switch',
        'remount', 'stop-dispose', 'client-exit','late-quota-client-fast-recovery','slow-quota-client-startup-grace',
        'unsupported-ui-no-injection','same-monitor-ui-recovery'], realClient: false,
    }, null, 2));
    console.log('PASS: monitor lifecycle (isolated loopback fixture)');
  } finally {
    if (running) { await control('stop'); await running; }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(sessionsRoot, { recursive: true, force: true });
    await rm(path.join(runtime, 'state.json'), { force: true });
  }
}
