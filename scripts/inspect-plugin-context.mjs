// Read-only capability probe. Export field names and allowlisted mode metadata only.
import { DatabaseSync } from 'node:sqlite';
import { open, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { UUID } from '../src/metrics.mjs';

const id = process.env.CODEX_THREAD_ID;
if (!id || !UUID.test(id)) throw new Error('current-session-id-unavailable');
const codexRoot = path.join(os.homedir(), '.codex');
const report = { sessionId: id, metadata: null, databases: [] };
const safeValue = (value) => {
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_. -]{0,79}$/.test(value)) return value;
  if (value && typeof value === 'object') return { keys: Object.keys(value).slice(0, 30) };
  return 'unrecognized';
};
const visit = async (dir, depth = 0) => {
  if (depth > 4) return;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await visit(file, depth + 1);
    else if (item.isFile() && item.name.endsWith(id + '.jsonl')) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(2 * 1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
        if (record.type !== 'session_meta' || record.payload?.id !== id) continue;
        const payload = record.payload;
        report.metadata = { keys: Object.keys(payload), modeHints: {} };
        for (const key of ['source', 'thread_source', 'originator', 'session_type', 'mode', 'thread_type', 'product', 'client']) {
          if (Object.hasOwn(payload, key)) report.metadata.modeHints[key] = safeValue(payload[key]);
        }
      } finally { await handle.close(); }
    }
  }
};
await visit(path.join(codexRoot, 'sessions'));
for (const name of ['state_5.sqlite', 'thread_history_1.sqlite']) {
  let db;
  const entry = { name, tables: [] };
  try {
    db = new DatabaseSync(path.join(codexRoot, name), { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const table of tables) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) continue;
      const columns = db.prepare('PRAGMA table_info("' + table.name + '")').all().map((row) => row.name);
      if (!columns.some((key) => /mode|source|thread_type|session_type/i.test(key))) continue;
      const details = { name: table.name, columns };
      const modeFields = columns.filter((key) => /^(source|originator|thread_source|mode|thread_type|session_type|conversation_mode|is_work|is_codex)$/.test(key));
      const idColumn = columns.includes('id') ? 'id' : columns.includes('thread_id') ? 'thread_id' : null;
      if (idColumn && modeFields.length) {
        const row = db.prepare('SELECT ' + modeFields.map((key) => '"' + key + '"').join(',')
          + ' FROM "' + table.name + '" WHERE "' + idColumn + '" = ? LIMIT 1').get(id);
        details.currentSession = row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeValue(value)])) : null;
      }
      entry.tables.push(details);
      if (table.name === 'threads' && columns.includes('originator')) {
        entry.originators = db.prepare('SELECT originator, count(*) AS count FROM threads GROUP BY originator')
          .all().map((row) => ({ originator: safeValue(row.originator), count: row.count }));
      }
    }
  } catch { entry.failure = 'read-only-schema-unavailable'; }
  finally { db?.close(); }
  report.databases.push(entry);
}
await mkdir('runtime/verification', { recursive: true });
await writeFile('runtime/verification/plugin-context.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
