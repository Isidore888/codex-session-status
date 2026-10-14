import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { root, control } from '../src/monitor.mjs';
import { CdpSession, listTargets } from '../src/cdp.mjs';
import { SessionStore } from '../src/sessions.mjs';
import { quotaExpression } from '../src/quota-bridge.mjs';
import { readQuota } from '../src/metrics.mjs';

// Read-only acceptance: inspect six values, numeric metadata and composer rectangles.
// No screenshot, chat text, account ID, or complete RPC response is collected.
let health = null;
const readyUntil = Date.now() + 20000;
do {
  health = await control('health');
  if (health?.connected) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
} while (Date.now() < readyUntil);
if (!health?.connected) {
  const output = path.join(root, 'runtime', 'verification');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'client-results.json'), JSON.stringify({
    schema:'six-fields-v18',checkedAt:new Date().toISOString(),passed:false,code:'native-cdp-not-connected',rows:[],
  }, null, 2));
  throw new Error('native-cdp-not-connected');
}
const state = JSON.parse(await readFile(path.join(root, 'runtime', 'state.json'), 'utf8'));
const pages = await listTargets(state.port);
const store = new SessionStore(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'));
const report = { schema: 'six-fields-v18', modeMeaning: 'persisted-conversation-working-identity',
  checkedAt: new Date().toISOString(), rows: [], passed: false, firstFourPassed: false,
  executionAccepted: false, taskDurationAccepted: false, executionCode: 'working-identity-pending', sessionSwitch: 'pending' };
const inspectExpression = '(' + function () {
  const api = window.__CODEX_SESSION_STATUS_V1__;
  if (!api) return [];
  const entries = api.inspect();
  const hosts = [...document.querySelectorAll('.codex-session-status-row')];
  return entries.map((entry) => {
    const host = hosts.find((item) => {
      if (item.dataset.statusThread !== (entry.threadId || '')
        || item.closest('[aria-hidden="true"],[inert],[data-app-shell-active-page="false"]')) return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!host) return { ...entry, geometryPass: false };
    const row = host.getBoundingClientRect();
    const composer = host.parentElement;
    const surface = composer.getBoundingClientRect();
    const field = composer.querySelector('textarea,[contenteditable="true"]')?.getBoundingClientRect();
    const buttons = [...composer.querySelectorAll('button')].map((item) => item.getBoundingClientRect())
      .filter((item) => item.width && item.height);
    const overlaps = (item) => row.left < item.right && row.right > item.left
      && row.top < item.bottom && row.bottom > item.top;
    const geometryPass = entry.visible && row.width > 0 && row.height > 0
      && row.left >= 0 && row.right <= window.innerWidth
      && row.bottom <= window.innerHeight && row.left >= surface.left && row.right <= surface.right
      && row.top >= surface.top && row.bottom <= surface.bottom
      && (!field || !overlaps(field)) && !buttons.some(overlaps);
    return { ...entry, cells: host.shadowRoot?.querySelectorAll('.value').length, geometryPass,
      noHoverOrBadge: !host.shadowRoot?.querySelector('[title],.update-state') };
  });
}.toString() + ')()';

for (const page of pages) {
  const connection = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    let rows = [];
    let quota = null;
    // Independent fresh quota can precede the documented 60-second display refresh.
    // Wait for that refresh, retaining exactly the same strict comparisons.
    const deadline = Date.now() + 75000;
    for (let attempt = 0; attempt < 10; attempt++) {
      rows = await connection.evaluate(inspectExpression);
      quota = readQuota(await connection.evaluate(quotaExpression, 15000));
      let allMatched = rows.length > 0;
      for (const row of rows) {
        const session = row.threadId ? await store.read(row.threadId) : { value: null, stale: false };
        const expected = await connection.evaluate('(' + function (session, quota, renderedAt) {
          const value = session.value;
          const tokens = value?.totalTokens;
          let tokenText = tokens == null ? '—' : tokens < 10000 ? new Intl.NumberFormat('zh-CN').format(tokens) : '';
          if (tokens >= 10000) {
            let remaining = Math.round(tokens / 1000) * 1000;
            for (const [scale, unit] of [[1e12,'万亿'],[1e8,'亿']]) {
              const count = Math.floor(remaining / scale);
              if (count) tokenText += count + unit;
              remaining %= scale;
            }
            const wan = Number((remaining / 10000).toFixed(1));
            if (wan) tokenText += wan + '万';
          }
          const task = session.task?.value;
          const elapsed = task ? task.durationMs ?? Math.max(0, renderedAt - task.startedAt) : null;
          const seconds = elapsed == null ? null : Math.floor(elapsed / 1000);
          const duration = seconds == null ? '—' : (seconds >= 3600 ? Math.floor(seconds / 3600) + ':' : '')
            + String(Math.floor(seconds / 60) % 60).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0');
          return [
            tokenText,
            value?.cacheHitPercent != null ? value.cacheHitPercent.toFixed(1) + '%' : '—',
            quota?.remainingPercent != null ? Number(quota.remainingPercent.toFixed(1)) + '%' : '—',
            quota?.resetsAt ? new Intl.DateTimeFormat(undefined, {
              hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(quota.resetsAt * 1000)) : '—',
            ['Codex','Work'].includes(session.mode?.value) ? session.mode.value : '未知',
            duration,
          ];
        }.toString() + ')(' + JSON.stringify(session) + ',' + JSON.stringify(quota) + ',' + JSON.stringify(row.renderedAt) + ')');
        const tokens = session.value?.totalTokens;
        const compactMatches = tokens != null && row.tokenTotal === tokens && row.values[0] === expected[0];
        row.matchesSources = Boolean(compactMatches) && JSON.stringify(row.values.slice(1)) === JSON.stringify(expected.slice(1));
        row.expected = expected;
        row.mismatchFields = [!compactMatches, ...row.values.slice(1).map((v,i)=>v!==expected[i+1])]
          .flatMap((mismatch,index)=>mismatch ? [index] : []);
        row.sourceAvailable = Boolean(session.value && quota && !session.stale);
        const staleMetadataValid = Array.isArray(row.staleFields) && row.staleFields.every((index) => Number.isInteger(index) && index >= 0 && index <= 5);
        row.firstFourPass = Boolean(compactMatches) && row.values.slice(1,4).every((v,i)=>v===expected[i+1])
          && row.sourceAvailable && row.cells === 6 && row.geometryPass && row.noHoverOrBadge;
        row.firstFourPass &&= staleMetadataValid && !row.staleFields.some((index) => index < 4);
        row.executionAccepted = ['Codex','Work'].includes(session.mode?.value)
          && !session.mode.stale && row.values[4] === expected[4] && staleMetadataValid && !row.staleFields.includes(4);
        row.modeSource = 'uuid-bound-rollout-originator';
        const task = session.task?.value;
        const expectedElapsed = task ? task.durationMs ?? Math.max(0, row.renderedAt - task.startedAt) : null;
        row.taskDurationAccepted = !session.task?.stale && staleMetadataValid && !row.staleFields.includes(5)
          && Number.isFinite(row.renderedAt) && row.taskElapsedMs === expectedElapsed && row.values[5] === expected[5];
        row.taskSource = task ? 'uuid-bound-root-task-events' : 'no-task-event';
        row.pass = row.firstFourPass && row.executionAccepted && row.taskDurationAccepted;
        allMatched &&= row.pass;
      }
      if (allMatched) break;
      if (Date.now() >= deadline) break;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, Math.min(8000,deadline-Date.now())));
    }
    report.rows.push(...rows);
  } finally { connection.close(); }
}
report.passed = report.rows.length > 0 && report.rows.every((row) => row.pass);
report.firstFourPassed = report.rows.length > 0 && report.rows.every((row) => row.firstFourPass);
report.executionAccepted = report.rows.length > 0 && report.rows.every((row) => row.executionAccepted);
report.taskDurationAccepted = report.rows.length > 0 && report.rows.every((row) => row.taskDurationAccepted);
report.executionCode = report.executionAccepted ? 'working-identity-verified' : 'working-identity-unavailable-or-mismatched';
const output = path.join(root, 'runtime', 'verification');
await mkdir(output, { recursive: true });
let history = [];
try {
  const saved = JSON.parse(await readFile(path.join(output, 'client-history.json'), 'utf8'));
  if (Array.isArray(saved)) history = saved.filter((entry) => entry.schema === report.schema).slice(-7);
} catch {}
const currentId = report.passed && report.rows.length === 1 ? report.rows[0].threadId : null;
if (currentId && history.some((entry) => entry.passed && entry.rows?.length === 1
  && entry.rows[0].threadId && entry.rows[0].threadId !== currentId)) {
  report.sessionSwitch = 'six-fields-verified-across-two-active-sessions';
}
await writeFile(path.join(output, 'client-results.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(output, 'client-history.json'), JSON.stringify([...history, report], null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
