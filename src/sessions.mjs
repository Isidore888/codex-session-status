import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { UUID, readUsage, chooseSnapshot } from './metrics.mjs';
import { identifyMode, mergeModes } from './mode.mjs';
import { advanceTask, chooseTask } from './task-time.mjs';

const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const HEADER_CHUNK_BYTES = 64 * 1024;
const FILE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function readFirstLineHeader(handle) {
  const chunks = [];
  let total = 0;
  while (total < MAX_HEADER_BYTES) {
    const length = Math.min(HEADER_CHUNK_BYTES, MAX_HEADER_BYTES - total);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (!bytesRead) break;
    const slice = buffer.subarray(0, bytesRead);
    const newline = slice.indexOf(10); // '\n'
    if (newline !== -1) {
      chunks.push(slice.subarray(0, newline));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    chunks.push(slice);
    total += bytesRead;
  }
  if (!chunks.length || total >= MAX_HEADER_BYTES) throw new Error('session-header-incomplete');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Index headers by conversation filename first; keep only usage, identity and root-task UUID/time metadata.
export class SessionStore {
  constructor(root) {
    this.root = root;
    this.files = new Map();
    this.lastValues = new Map();
    this.lastModes = new Map();
    this.lastTasks = new Map();
    this.failedIds = new Set();
    this.indexedAt = 0;
    this.indexedById = new Map();
    this.indexFailed = false;
  }
  async indexFile(file) {
    if (this.files.has(file)) return true;
    let handle;
    try {
      handle = await open(file, 'r');
      const header = await readFirstLineHeader(handle);
      const id = header.type === 'session_meta' ? header.payload?.id : null;
      if (typeof id === 'string' && UUID.test(id)) {
        this.files.set(file, { id: id.toLowerCase(), offset: 0, partial: '',
          decoder: new StringDecoder('utf8'), snapshot: null, task: null, order: 0, identity: null,
          mode: identifyMode(header.payload?.originator) });
        return true;
      }
    } catch { /* Growing headers are retried at the next index pass. */ }
    finally { await handle?.close(); }
    return false;
  }
  async discover(force = false, targetId = null) {
    const normalizedId = typeof targetId === 'string' && UUID.test(targetId) ? targetId.toLowerCase() : null;
    const now = Date.now();
    if (normalizedId) {
      const last = this.indexedById.get(normalizedId) ?? 0;
      if (!force && now - last < 15000) return;
      this.indexedById.set(normalizedId, now);
    } else {
      if (!force && now - this.indexedAt < 15000) return;
      this.indexedAt = now;
    }
    this.indexFailed = false;
    if (normalizedId) {
      const directFile = path.join(this.root, normalizedId + '.jsonl');
      try {
        if ((await stat(directFile)).isFile()) await this.indexFile(directFile);
      } catch {}
    }
    const matchedFiles = [];
    const fallbackFiles = [];
    const visit = async (directory, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { this.indexFailed = true; return; }
      entries.sort((left, right) => right.name.localeCompare(left.name));
      for (const item of entries) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) { await visit(file, depth + 1); continue; }
        if (!item.isFile() || !item.name.endsWith('.jsonl') || this.files.has(file)) continue;
        const nameIds = item.name.toLowerCase().match(FILE_UUID);
        if (normalizedId) {
          if (nameIds) {
            if (nameIds.includes(normalizedId)) matchedFiles.push(file);
            // Skip unrelated UUID-named rollout files without opening them.
          } else {
            fallbackFiles.push(file);
          }
        } else {
          matchedFiles.push(file);
        }
      }
    };
    await visit(this.root);
    for (const file of matchedFiles) await this.indexFile(file);
    for (const file of fallbackFiles) await this.indexFile(file);
  }
  async scan(file, state) {
    const details = await stat(file);
    const identity = String(details.dev) + ':' + String(details.ino) + ':' + String(details.birthtimeMs);
    if (details.size < state.offset || (state.identity && state.identity !== identity)) {
      Object.assign(state, { offset: 0, partial: '', decoder: new StringDecoder('utf8'),
        snapshot: null, task: null, order: 0, mode: null });
    }
    state.identity = identity;
    const end = details.size;
    const handle = await open(file, 'r');
    try {
      if (state.offset === 0) {
        const header = await readFirstLineHeader(handle);
        const nextId = header.type === 'session_meta' && typeof header.payload?.id === 'string'
          && UUID.test(header.payload.id) ? header.payload.id.toLowerCase() : null;
        if (nextId !== state.id) {
          this.failedIds.add(state.id);
          if (nextId) {
            Object.assign(state, { id: nextId, offset: 0, partial: '',
              decoder: new StringDecoder('utf8'), snapshot: null, task: null, order: 0,
              mode: identifyMode(header.payload?.originator) });
          } else {
            this.files.delete(file);
          }
          throw new Error('session-identity-changed');
        }
        state.mode = identifyMode(header.payload?.originator);
      }
      const buffer = Buffer.alloc(256 * 1024);
      while (state.offset < end) {
        const length = Math.min(buffer.length, end - state.offset);
        const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const text = state.partial + state.decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split('\n');
        state.partial = lines.pop();
        for (const line of lines) {
          state.order++;
          if (!/"(?:token_count|task_started|task_complete|turn_aborted)"/.test(line)) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.type !== 'event_msg') continue;
          if (record.payload?.type !== 'token_count') {
            state.task = advanceTask(state.task, record);
            continue;
          }
          const value = readUsage(record.payload.info);
          const timestamp = Date.parse(record.timestamp);
          if (value && Number.isFinite(timestamp)) {
            state.snapshot = chooseSnapshot(state.snapshot, { value, timestamp, order: state.order });
          }
        }
        if (state.partial.length > 16 * 1024 * 1024) throw new Error('session-record-too-large');
      }
    } finally { await handle.close(); }
  }
  async read(id, force = false) {
    if (typeof id !== 'string' || !UUID.test(id)) return { value: null, stale: false };
    id = id.toLowerCase();
    const known = [...this.files.values()].some((file) => file.id === id);
    const lastIndexed = this.indexedById.get(id) ?? this.indexedAt;
    const shouldDiscover = force || (known
      ? Date.now() - lastIndexed >= 15000
      : (!this.indexedById.has(id) || Date.now() - lastIndexed >= 3000));
    if (shouldDiscover) await this.discover(true, id);
    let latest = null;
    let task = null;
    let failed = this.indexFailed;
    let scannedCount = 0;
    const modes = [];
    for (const [file, state] of this.files) {
      if (state.id !== id) continue;
      try {
        await this.scan(file, state);
        scannedCount++;
      } catch { failed = true; }
      if (state.id !== id) continue;
      modes.push(state.mode);
      latest = chooseSnapshot(latest, state.snapshot);
      task = chooseTask(task, state.task);
    }
    if (!failed && scannedCount > 0) {
      this.failedIds.delete(id);
    }
    failed ||= this.failedIds.has(id);
    const value = latest?.value ?? null;
    const mode = mergeModes(modes);
    if (failed) return { value: this.lastValues.get(id) ?? value, stale: true,
      task: { value: this.lastTasks.get(id) ?? task, stale: true },
      mode: { value: this.lastModes.has(id) ? this.lastModes.get(id) : mode, stale: true } };
    this.lastValues.set(id, value);
    this.lastModes.set(id, mode);
    this.lastTasks.set(id, task);
    return { value, stale: false, mode: { value: mode, stale: false }, task: { value: task, stale: false } };
  }
}
