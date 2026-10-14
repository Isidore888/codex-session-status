export function loopbackUrl(value, protocols = ['http:', 'ws:']) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.hostname !== '127.0.0.1'
    || url.username || url.password) throw new Error('non-loopback-endpoint');
  return url;
}

export async function listTargets(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid-port');
  const response = await fetch('http://127.0.0.1:' + port + '/json/list',
    { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!response.ok) throw new Error('cdp-unavailable');
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error('cdp-response-too-large');
  const targets = JSON.parse(body);
  if (!Array.isArray(targets)) throw new Error('invalid-target-list');
  return targets.filter((target) => {
    try {
      const page = new URL(target.url);
      const socket = loopbackUrl(target.webSocketDebuggerUrl, ['ws:']);
      return target.type === 'page' && page.protocol === 'app:'
        && page.pathname === '/index.html' && !page.searchParams.has('initialRoute')
        && Number(socket.port) === port;
    } catch { return false; }
  });
}

export class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    this.onContextChange = null;
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.method === 'Runtime.bindingCalled'
        && message.params?.name === '__codexSessionStatusChanged') this.onContextChange?.();
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error('cdp-request-failed'));
      else item.resolve(message.result);
    });
    socket.addEventListener('close', () => this.fail());
    socket.addEventListener('error', () => this.fail());
  }
  static async connect(address) {
    loopbackUrl(address, ['ws:']);
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('cdp-connect-timeout')); }, 4000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-connect-failed')); }, { once: true });
    });
    return new CdpSession(socket);
  }
  send(method, params, timeout = 4000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('cdp-closed')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('cdp-timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('cdp-send-failed')); }
    });
  }
  async evaluate(expression, timeout = 4000) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, timeout);
    if (result.exceptionDetails) throw new Error('renderer-evaluation-failed');
    return result.result?.value;
  }
  fail() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer); item.reject(new Error('cdp-closed'));
    }
    this.pending.clear();
  }
  close() { this.fail(); this.socket.close(); }
}
