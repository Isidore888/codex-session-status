import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StatusService } from './lib/status.mjs';
import { DesktopQuotaReader } from './lib/desktop-quota.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const mimeType = 'text/html;profile=mcp-app';
const uri = 'ui://session-status/panel.html';
const native = new DesktopQuotaReader(process.env.CODEX_APP_TOOLS_PIPE_PATH);
const service = new StatusService({ codexRoot: path.join(os.homedir(), '.codex'),
  dataDirectory: process.env.SESSION_STATUS_DATA_DIR || path.join(root, '..', 'runtime', 'plugin'),
  quotaReader: (id, mode) => native.read(id, mode) });
const schema = { type: 'object', properties: { session_id: { type: 'string',
  description: 'Exact current local conversation UUID, only needed if executor thread metadata is unavailable.',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } }, additionalProperties: false };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
let uiSupported = false;
let initialized = false;
const response = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const failure = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id,
  error: { code, message } }) + '\n');

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    failure(message?.id ?? null, -32600, 'Invalid request'); return;
  }
  if (!Object.hasOwn(message, 'id')) return; // Notifications/cancellation never trigger reads.
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    initialized = true;
    uiSupported = params.capabilities?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes?.includes(mimeType) === true;
    response(id, { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion)
      ? params.protocolVersion : '2025-11-25', capabilities: { tools: {}, resources: {},
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [mimeType] } } },
      serverInfo: { name: 'session-status', version: '0.2.0' },
      instructions: 'Read-only six-field local conversation status. Use executor thread metadata; never substitute the latest log or anonymized openai/session. Unknown values stay unknown.' }); return;
  }
  if (!initialized) { failure(id, -32000, 'Initialize first'); return; }
  if (method === 'ping') { response(id, {}); return; }
  if (method === 'tools/list') {
    const tool = { name: 'show_session_status', title: '会话状态',
      description: 'Show current conversation total tokens, cached-input hit rate, codex 300-minute remaining quota, local reset time, verified Codex/Work mode, and task duration. Read only.',
      inputSchema: schema, annotations };
    if (uiSupported) tool._meta = { ui: { resourceUri: uri, visibility: ['model', 'app'] },
      'openai/ui': { entrypoints: [{ type: 'thread' }] } };
    response(id, { tools: [tool, { name: 'read_session_status', title: '刷新会话状态',
      description: 'Read the six status fields without creating a new widget.', inputSchema: schema, annotations,
      _meta: { ui: { visibility: ['app'] } } }] }); return;
  }
  if (method === 'resources/list') { response(id, { resources: [{ uri, name: '会话状态', mimeType }] }); return; }
  if (method === 'resources/templates/list') { response(id, { resourceTemplates: [] }); return; }
  if (method === 'resources/read') {
    if (params.uri !== uri) { failure(id, -32602, 'Unknown resource'); return; }
    response(id, { contents: [{ uri, mimeType, text: await readFile(path.join(root, 'panel.html'), 'utf8'),
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/ui': { availableDisplayModes: ['inline', 'pip', 'fullscreen'] } } }] }); return;
  }
  if (method === 'tools/call') {
    if (!['show_session_status', 'read_session_status'].includes(params.name)) {
      failure(id, -32602, 'Unknown tool'); return;
    }
    const args = params.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => key !== 'session_id')
      || (args.session_id != null && (typeof args.session_id !== 'string' || !new RegExp(schema.properties.session_id.pattern).test(args.session_id)))) {
      failure(id, -32602, 'Invalid session arguments'); return;
    }
    const data = await service.read(args, params._meta);
    response(id, { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }); return;
  }
  failure(id, -32601, 'Method not found');
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 1024 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { failure(null, -32700, 'Parse error'); continue; }
    handle(message).catch(() => failure(message?.id ?? null, -32603, 'Status reader unavailable'));
  }
});
