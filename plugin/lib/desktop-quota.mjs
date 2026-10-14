import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { UUID } from './metrics.mjs';

// Version-sensitive adapter to the installed official desktop tools. No CDP or auth files.
// The only native calls allowed are catalog discovery and the advertised usage reader.
export class DesktopQuotaReader {
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.nextId = 1;
    this.tool = null;
  }
  async request(method, params) {
    if (method !== 'tools/list' && method !== 'tools/call') throw new Error('native-method-denied');
    if (method === 'tools/call' && (!this.tool || params.tool !== 'get_usage_limits'
      || params.namespace !== this.tool.namespace || Object.keys(params.arguments).length !== 0)) {
      throw new Error('native-tool-denied');
    }
    if (typeof this.pipePath !== 'string' || !this.pipePath.startsWith('\\\\.\\pipe\\')) {
      throw new Error('desktop-pipe-unavailable');
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const socket = net.createConnection(this.pipePath);
      let buffer = Buffer.alloc(0);
      let finished = false;
      const finish = (value, failure) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        failure ? reject(new Error(failure)) : resolve(value);
      };
      const timer = setTimeout(() => finish(null, 'desktop-pipe-timeout'), 5000);
      socket.once('connect', () => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      });
      socket.on('data', (chunk) => {
        if (buffer.length + chunk.length > 8 * 1024 * 1024 + 4) return finish(null, 'desktop-frame-too-large');
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > 8 * 1024 * 1024) return finish(null, 'desktop-frame-too-large');
          if (buffer.length < length + 4) return;
          let message;
          try { message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')); }
          catch { return finish(null, 'desktop-frame-invalid'); }
          buffer = buffer.subarray(length + 4);
          if (message.id !== id) continue;
          if(message.error) this.lastFailureHints=['turnId','turn_id','threadId','callerSource','hostId','missing','unknown','not found','authentication']
            .filter(hint=>String(message.error.message||'').includes(hint));
          return message.error ? finish(null, 'desktop-request-failed-' + method.replace('/','-') + '-'
            + (Number.isSafeInteger(message.error.code) ? message.error.code : 'unknown')) : finish(message.result);
        }
      });
      socket.once('error', (error) => finish(null, 'desktop-pipe-failed-'
        + (['EACCES','EPERM','ENOENT','ECONNREFUSED'].includes(error.code) ? error.code : 'unknown')));
      socket.once('close', () => finish(null, 'desktop-pipe-closed'));
    });
  }
  async read(sessionId, mode) {
    if (!UUID.test(sessionId)) throw new Error('session-unavailable');
    if (!this.tool) {
      const catalog = await this.request('tools/list', { threadStartKind: 'all' });
      const matches = catalog?.tools?.filter((item) => item.name === 'get_usage_limits'
        && typeof item.namespace === 'string');
      if (matches?.length !== 1) throw new Error('desktop-usage-tool-unavailable');
      this.tool = { name: matches[0].name, namespace: matches[0].namespace };
    }
    const result = await this.request('tools/call', {
      // This is an executor MCP adapter, as in the bundled server without interaction-client-id.
      // The originator identifies conversation mode, not the RPC caller transport.
      arguments: {}, callerSource: 'codex',
      callId: 'session-status-' + randomUUID(), hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID,
      namespace: this.tool.namespace,
      threadId: sessionId, tool: this.tool.name,
      turnId: 'session-status-read-' + randomUUID(),
    });
    if (!result?.success || !Array.isArray(result.contentItems)) throw new Error('desktop-usage-failed');
    for (const item of result.contentItems) {
      if (item.type !== 'inputText' || typeof item.text !== 'string' || item.text.length > 1024 * 1024) continue;
      let parsed;
      try { parsed = JSON.parse(item.text); } catch { continue; }
      const bucket = parsed.rateLimitsByLimitId?.codex ?? parsed.rateLimits;
      if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) continue;
      const copy = (value) => value ? { usedPercent: value.usedPercent,
        windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt } : null;
      // Discard full response, account IDs, credit identifiers and unrelated windows.
      return { rateLimits: { limitId: 'codex', primary: copy(bucket.primary), secondary: copy(bucket.secondary) } };
    }
    throw new Error('desktop-usage-response-unavailable');
  }
}
