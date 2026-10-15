// This function is serialized into the renderer. It reads only composer metadata.
export function installStatusRow() {
  const key = '__CODEX_SESSION_STATUS_V1__';
  if (window[key]) return { installed: true };
  const selector = '[class*="ComposerLayoutRoot"],[data-testid="composer"]';
  const idAttributes = ['data-above-composer-conversation-id', 'data-conversation-id', 'data-thread-id'];
  const idSelector = idAttributes.map((name) => '[' + name + ']').join(',');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rows = new Map();
  const retainedRows = new Map(); // Reuse only for the same explicit conversation UUID (LRU bounded).
  const taskTimes = new Map(); // Survives row reuse/remount; only UUID-bound numeric metadata.
  let data = { sessions: {}, quota: { value: null, stale: false } };
  let scheduled = false;
  let disposed = false;
  let contextKey = '';
  const active = (node) => !node.closest('[data-app-shell-active-page="false"],[aria-hidden="true"],[inert]');
  const visible = (node) => active(node) && node.getBoundingClientRect().width > 0
    && node.getBoundingClientRect().height > 0;
  function tokenText(total) {
    if (total == null) return '—';
    if (total < 10000) return new Intl.NumberFormat('zh-CN').format(total);
    total = Math.round(total / 1000) * 1000;
    let text = '';
    for (const [scale, unit] of [[1e12, '万亿'], [1e8, '亿']]) {
      const count = Math.floor(total / scale);
      if (count) text += count + unit;
      total %= scale;
    }
    const wan = Number((total / 10000).toFixed(1));
    if (wan) text += wan + '万';
    return text;
  }
  function durationText(milliseconds) {
    if (milliseconds == null) return '—';
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return (hours ? hours + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }
  function elapsedFor(id, task, now) {
    if (!task.value) {
      if (!task.stale) taskTimes.delete(id);
      return null;
    }
    const value = task.value;
    const previous = taskTimes.get(id);
    const sameTask = previous?.turnId === value.turnId && previous?.startedAt === value.startedAt;
    if (task.stale) return sameTask ? previous.elapsedMs : value.durationMs ?? null;
    const elapsedMs = value.durationMs ?? Math.max(0, now - value.startedAt);
    if (id) taskTimes.set(id, { turnId: value.turnId, startedAt: value.startedAt, elapsedMs });
    return elapsedMs;
  }
  function context(composer, includeInactive = false) {
    const page = composer.closest('[data-app-shell-active-page]');
    if (includeInactive && !page) return { id: null, supported: false };
    let scope = composer;
    while (scope && scope !== document.body) {
      const markers = [...scope.querySelectorAll(idSelector)];
      if (idAttributes.some((attribute) => scope.hasAttribute(attribute))) markers.push(scope);
      const identifiers = new Set();
      let ordinaryChat = false;
      for (const marker of markers.filter((node) => (!page || node.closest('[data-app-shell-active-page]') === page)
        && (includeInactive || active(node)))) {
        for (const attribute of idAttributes) {
          const value = marker.getAttribute(attribute) || '';
          if (/^chatgpt\s*:/i.test(value)) ordinaryChat = true;
          if (uuid.test(value)) identifiers.add(value.toLowerCase());
        }
      }
      if (identifiers.size === 1) return { id: [...identifiers][0], supported: true };
      if (ordinaryChat && identifiers.size === 0) return { id: null, supported: false };
      if (identifiers.size > 1) break;
      if (scope === page) break; // Never borrow the UUID of another native page.
      scope = scope.parentElement;
    }
    const field = composer.querySelector('textarea,[contenteditable="true"]');
    const labels = ['placeholder', 'aria-label', 'data-placeholder']
      .map((attribute) => field?.getAttribute(attribute) || '').join(' ');
    return { id: null, supported: !/\bChatGPT\b/i.test(labels) || /\bChatGPT\s+(Work|工作)\b/i.test(labels) };
  }
  function newRow(composer) {
    const host = document.createElement('div');
    host.className = 'codex-session-status-row';
    host.style.cssText = 'display:block;flex:0 0 auto;min-width:0;max-width:100%;margin:0 12px 4px;order:999;font:inherit;font-size:var(--text-button-composer,var(--text-sm,.875em));line-height:var(--line-height-button-composer,1.285714);color:inherit;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.metrics{display:flex;flex-wrap:wrap;align-items:center;gap:3px 8px;font:inherit;color:inherit;font-variant-numeric:tabular-nums;padding-top:4px} .metric{display:inline-flex;align-items:baseline;min-width:0;gap:4px} .label{opacity:.62;white-space:nowrap} .value{font-weight:500;opacity:.92;white-space:nowrap} .stale .value{opacity:.65}';
    const bar = document.createElement('div');
    bar.className = 'metrics';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Codex 会话用量');
    const cells = ['累计Token', '缓存命中率', '5小时剩余', '重置时间', '执行模式', '任务耗时'].map((label) => {
      const cell = document.createElement('span');
      cell.className = 'metric';
      const name = document.createElement('span');
      name.className = 'label';
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'value';
      cell.append(name, value);
      bar.append(cell);
      return { cell, value, label };
    });
    shadow.append(style, bar);
    composer.append(host); // Only a verified native column with the input background is passed here.
    return { host, cells, id: undefined };
  }
  function retainRow(row) {
    if (!row) return;
    row.host.remove();
    if (row.id && uuid.test(row.id)) {
      retainedRows.delete(row.id);
      retainedRows.set(row.id, row);
      if (retainedRows.size > 16) retainedRows.delete(retainedRows.keys().next().value);
    }
  }
  function surface(composer) {
    const paintedColumn = (node) => {
      const style = getComputedStyle(node);
      const color = style.backgroundColor;
      return style.display === 'flex' && style.flexDirection === 'column'
        && color !== 'transparent' && !/^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color);
    };
    if (paintedColumn(composer)) return composer;
    // Draft composers put their background on ComposerLayoutBody; the root also
    // contains spacing and project controls, so appending there puts the row outside.
    const field = composer.querySelector('textarea,[contenteditable="true"]');
    const body = field ? field.closest('[class*="ComposerLayoutBody"]') : rows.get(composer)?.host.parentElement;
    return body?.matches('[class*="ComposerLayoutBody"]') && body.closest(selector) === composer
      && paintedColumn(body) ? body : null;
  }
  function render(row, selection) {
    const session = data.sessions[selection.id] || { value: null, stale: false };
    // Latest requirement: retained UUID-bound conversation working identity.
    // UI branding and model/tool/permission changes do not reclassify this identity.
    const mode = session.mode || { value: null, stale: false };
    const workingIdentity = ['Codex', 'Work'].includes(mode.value) ? mode.value : '未知';
    const quota = data.quota || { value: null, stale: false };
    const usage = session.value;
    const task = session.task || { value: null, stale: false };
    const renderedAt = Date.now();
    const taskElapsed = elapsedFor(selection.id, task, renderedAt);
    const window = quota.value;
    const reset = window?.resetsAt ? new Date(window.resetsAt * 1000) : null;
    const clock = reset ? new Intl.DateTimeFormat(undefined, {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(reset) : '—';
    const values = [
      tokenText(usage?.totalTokens),
      usage?.cacheHitPercent != null ? usage.cacheHitPercent.toFixed(1) + '%' : '—',
      window?.remainingPercent != null ? Number(window.remainingPercent.toFixed(1)) + '%' : '—',
      clock,
      workingIdentity,
      durationText(taskElapsed),
    ];
    row.cells.forEach((cell, index) => {
      const stale = index === 5 ? task.stale : index === 4 ? mode.stale : index < 2 ? session.stale : quota.stale;
      const text = values[index];
      if (cell.value.textContent !== text) cell.value.textContent = text;
      if (cell.cell.classList.contains('stale') !== Boolean(stale)) cell.cell.classList.toggle('stale', Boolean(stale));
      const label = cell.label + '：' + text + (stale ? '，未更新' : '');
      if (cell.cell.getAttribute('aria-label') !== label) cell.cell.setAttribute('aria-label', label);
    });
    row.tokenTotal = usage?.totalTokens ?? null;
    row.renderedAt = renderedAt;
    row.taskElapsedMs = taskElapsed;
    row.id = selection.id;
    const statusId = selection.id || '';
    if (row.host.dataset.statusThread !== statusId) row.host.dataset.statusThread = statusId;
  }
  function sync() {
    scheduled = false;
    if (disposed) return;
    const composers = [...document.querySelectorAll(selector)].filter((composer) => {
      const field = composer.querySelector('textarea,[contenteditable="true"]');
      const layout = getComputedStyle(composer);
      if (layout.display !== 'flex' || layout.flexDirection !== 'column' || !surface(composer)) return false;
      if (field) return field.closest(selector) === composer;
      // Native idle submit briefly removes the editor while retaining its shell/UUID.
      // Keep an already verified row only for that same explicit conversation.
      const row = rows.get(composer);
      const selection = context(composer, !active(composer));
      return Boolean(row?.id && selection.supported && selection.id === row.id);
    });
    for (const [composer, row] of rows) {
      if (!composers.includes(composer)) {
        retainRow(row); rows.delete(composer);
      }
    }
    for (const composer of composers) {
      const inactive = !active(composer);
      const selection = context(composer, inactive);
      if (!selection.supported || (inactive && !selection.id)) {
        retainRow(rows.get(composer)); rows.delete(composer); continue;
      }
      const parent = surface(composer);
      const row = rows.get(composer) || retainedRows.get(selection.id) || newRow(parent);
      retainedRows.delete(selection.id);
      if (row.host.parentElement !== parent) parent.append(row.host);
      rows.set(composer, row);
      render(row, selection);
    }
    const nextKey = shownRows().map((row) => row.id || '').sort().join('|');
    if (nextKey !== contextKey) {
      contextKey = nextKey;
      window.__codexSessionStatusChanged?.('changed');
    }
  }
  function shownRows() { return [...rows.values()].filter((row) => visible(row.host)); }
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (record.type === 'attributes') {
        return idAttributes.includes(record.attributeName)
          || (record.target.nodeType === 1 && (record.target.closest(selector) || record.target.querySelector(selector)));
      }
      return (record.target.nodeType === 1 && record.target.closest(selector))
        || [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
          && (node.matches(selector) || node.querySelector(selector)));
    });
    // Repair a native composer commit in this microtask, before its first paint.
    // Deferring to another animation frame briefly shrinks then expands the input.
    if (relevant) sync();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
    attributeFilter: [...idAttributes, 'data-app-shell-active-page', 'aria-hidden', 'inert', 'placeholder'] });
  const onResize = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(sync); } };
  window.addEventListener('resize', onResize);
  window[key] = {
    compatibility() {
      sync();
      const fields = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
      const nativeField = fields.some((field) => /\b(Codex|ChatGPT\s+(Work|工作))\b/i.test(
        ['placeholder','aria-label','data-placeholder'].map((name) => field.getAttribute(name) || '').join(' ')));
      return shownRows().length ? 'supported' : nativeField ? 'unsupported' : 'idle';
    },
    contexts() { sync(); return [...new Set(shownRows().map((row) => row.id).filter(Boolean))]; },
    readContexts() { sync(); return [...new Set([...rows.values()].map((row) => row.id).filter(Boolean))]; },
    update(next) {
      // No active composer during a native remount is not a failed/empty source read.
      // Keep each UUID's last response; a present empty/stale response still replaces it.
      data = { ...next, sessions: { ...data.sessions, ...next.sessions } };
      sync(); return { rows: shownRows().length, contexts: this.contexts() };
    },
    inspect() {
      sync();
      return shownRows().map((row) => ({
        threadId: row.id, values: row.cells.map((cell) => cell.value.textContent),
        tokenTotal: row.tokenTotal, renderedAt: row.renderedAt, taskElapsedMs: row.taskElapsedMs,
        staleFields: row.cells.flatMap(({ cell }, index) => cell.classList.contains('stale') ? [index] : []),
        visible: visible(row.host), width: row.host.getBoundingClientRect().width,
      }));
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      for (const row of rows.values()) row.host.remove();
      rows.clear();
      retainedRows.clear();
      taskTimes.clear();
      delete window[key];
    },
  };
  sync();
  return { installed: true, rows: shownRows().length };
}

export const installExpression = '(' + installStatusRow.toString() + ')()';
export const contextsExpression = 'window.__CODEX_SESSION_STATUS_V1__?.readContexts() || []';
export const removeExpression = 'window.__CODEX_SESSION_STATUS_V1__?.dispose(); delete window.__codexSessionStatusChanged';
export function updateExpression(data) {
  return 'window.__CODEX_SESSION_STATUS_V1__?.update(' + JSON.stringify(data) + ')';
}
