import { mkdir, appendFile, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './sessions.mjs';
import { quotaProbeExpression } from './quota-bridge.mjs';
import { CdpSession, listTargets } from './cdp.mjs';
import { quotaState, nextQuotaRefresh } from './metrics.mjs';
import { installExpression, contextsExpression, updateExpression, removeExpression } from './renderer.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtime = path.join(root, 'runtime');
export const pipeAddress = process.platform === 'win32'
  ? '\\\\.\\pipe\\codex-session-status-' + createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20)
  : path.join(runtime, 'monitor.sock');

export function control(action, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipeAddress);
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeout);
    socket.on('connect', () => socket.end(action + '\n'));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(response)); } catch { resolve(null); }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

async function log(code) {
  // Codes only: no account identifiers, source messages, or raw RPC diagnostics.
  const file = path.join(runtime, 'monitor.log');
  try {
    if ((await stat(file)).size > 512 * 1024) await writeFile(file, '');
  } catch {}
  await appendFile(file, new Date().toISOString() + ' ' + code + '\n');
}

export async function runMonitor({ port, sessionsRoot, clientKey = null, appVersion = null }) {
  await mkdir(runtime, { recursive: true });
  const existing = await control('health');
  if (existing?.ok) return;
  let stopped = false;
  let connected = false;
  let absentSince = Date.now();
  let quota = { value: null, stale: false };
  let quotaSchedule = { failures: 0, nextAttemptAt: 0 };
  let refreshing = false;
  let lastRowCount = -1;
  const targets = new Map();
  const sessions = new SessionStore(sessionsRoot);
  let quotaRequest = null;
  let wakeWait = null;
  let changed = false;
  const wake = () => { changed = true; wakeWait?.(); };
  const wait = (milliseconds) => new Promise((resolve) => {
    if (changed) { changed = false; resolve(); return; }
    const finish = () => { clearTimeout(timer); wakeWait = null; changed = false; resolve(); };
    const timer = setTimeout(finish, milliseconds);
    wakeWait = finish;
  });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let command = '';
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('data', (chunk) => {
      command += chunk;
      if (command.length > 32) { socket.destroy(); return; }
      if (!command.includes('\n')) return;
      const action = command.trim();
      socket.end(JSON.stringify({ ok: action === 'health' || action === 'stop', connected, rows: lastRowCount }));
      if (action === 'stop') { stopped = true; wake(); }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeAddress, resolve);
  });
  await writeFile(path.join(runtime, 'state.json'), JSON.stringify({
    pid: process.pid, port, clientKey, appVersion, version: '0.1.0', startedAt: new Date().toISOString(),
  }, null, 2));
  const stop = () => { stopped = true; wake(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await log('started');
  async function refreshQuota() {
    if (refreshing) return;
    const connection = targets.values().next().value;
    if (!connection) return;
    refreshing = true;
    try {
      const probe = await connection.evaluate(quotaProbeExpression, 15000);
      if (probe?.code || !probe || !Object.hasOwn(probe, 'value')) throw new Error('quota-unavailable');
      quota = quotaState(quota, probe.value);
      quotaSchedule = nextQuotaRefresh(quotaSchedule, Date.now(), true);
    }
    catch {
      quota = quotaState(quota, null, true);
      quotaSchedule = nextQuotaRefresh(quotaSchedule, Date.now(), false);
      await log('quota-unavailable');
    } finally { refreshing = false; wake(); }
  }
  try {
    let broughtToFrontOnConnect = false;
    let broughtToFrontOnMount = false;
    while (!stopped) {
      let pages;
      try { pages = await listTargets(port); }
      catch { pages = null; }
      if (!pages?.length) {
        connected = false;
        for (const connection of targets.values()) connection.close();
        targets.clear();
        // Allow a short update/reload gap; never leave a permanent orphan daemon.
        if (Date.now() - absentSince > 30000) break;
        await wait(1000); continue;
      }
      connected = true;
      absentSince = Date.now();
      for (const [id, connection] of targets) {
        if (!pages.some((page) => page.id === id)) { connection.close(); targets.delete(id); }
      }
      let rowCount = 0;
      for (const page of pages) {
        try {
          let connection = targets.get(page.id);
          if (!connection) {
            connection = await CdpSession.connect(page.webSocketDebuggerUrl);
            targets.set(page.id, connection);
            connection.onContextChange = wake;
            await connection.send('Runtime.addBinding', { name: '__codexSessionStatusChanged' });
            if (!broughtToFrontOnConnect) {
              broughtToFrontOnConnect = true;
              try { await connection.send('Page.bringToFront'); } catch {}
            }
          }
          await connection.evaluate(installExpression);
          const compatibility = await connection.evaluate('window.__CODEX_SESSION_STATUS_V1__?.compatibility()');
          // Unknown layouts receive no updates; keep the connection for native UI recovery.
          if (compatibility === 'unsupported') continue;
          const identifiers = await connection.evaluate(contextsExpression);
          const data = {};
          for (const id of identifiers) data[id] = await sessions.read(id);
          const result = await connection.evaluate(updateExpression({ sessions: data, quota }));
          rowCount += result?.rows || 0;
          if (rowCount > 0 && !broughtToFrontOnMount) {
            broughtToFrontOnMount = true;
            try { await connection.send('Page.bringToFront'); } catch {}
          }
        } catch {
          targets.get(page.id)?.close(); targets.delete(page.id);
        }
      }
      if (Date.now() >= quotaSchedule.nextAttemptAt && !refreshing) quotaRequest = refreshQuota();
      if (rowCount !== lastRowCount) {
        await log(rowCount > 0 ? 'status-row-mounted' : 'composer-not-found');
        lastRowCount = rowCount;
      }
      await wait(2000);
    }
  } finally {
    for (const connection of targets.values()) {
      try { await connection.evaluate(removeExpression); } catch {}
      connection.close();
    }
    await quotaRequest;
    await new Promise((resolve) => server.close(resolve));
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await log('stopped');
    await writeFile(path.join(runtime, 'state.json'), JSON.stringify({ pid: process.pid, port, clientKey, appVersion, exitReason:'stopped', stoppedAt: new Date().toISOString() }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === '--health' || action === '--stop') {
    const result = await control(action === '--stop' ? 'stop' : 'health');
    console.log(JSON.stringify(result || { ok: false }));
    process.exitCode = action === '--health' && !result?.ok ? 1 : 0;
  } else if (action === '--run') {
    const config = JSON.parse(await readFile(path.join(runtime, 'launch.json'), 'utf8'));
    await runMonitor({
      port: config.port,
      clientKey: config.clientKey ?? null, appVersion: config.appVersion ?? null,
      sessionsRoot: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    }).catch(async () => { await log('monitor-failed'); process.exitCode = 1; });
  }
}
