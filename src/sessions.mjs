import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { UUID, readUsage, chooseSnapshot } from './metrics.mjs';
import { identifyMode, mergeModes } from './mode.mjs';
import { advanceTask, chooseTask } from './task-time.mjs';

// Index headers; keep only usage, identity and root-task UUID/time metadata.
export class SessionStore {
  constructor(root) {
    this.root = root;
    this.files = new Map();
    this.lastValues = new Map();
    this.lastModes = new Map();
    this.lastTasks = new Map();
    this.indexedAt = 0;
    this.indexFailed = false;
  }
  async discover(force = false) {
    if (!force && Date.now() - this.indexedAt < 15000) return;
    this.indexedAt = Date.now();
    this.indexFailed = false;
    const visit = async (directory, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { this.indexFailed = true; return; }
      for (const item of entries) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) { await visit(file, depth + 1); continue; }
        if (!item.isFile() || !item.name.endsWith('.jsonl') || this.files.has(file)) continue;
        let handle;
        try {
          handle = await open(file, 'r');
          const bytes = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          const first = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0];
          const header = JSON.parse(first);
          const id = header.type === 'session_meta' ? header.payload?.id : null;
          if (typeof id === 'string' && UUID.test(id)) {
            this.files.set(file, { id: id.toLowerCase(), offset: 0, partial: '',
              decoder: new StringDecoder('utf8'), snapshot: null, task: null, order: 0, identity: null,
              mode: identifyMode(header.payload?.originator) });
          }
        } catch { /* Growing headers are retried at the next index pass. */ }
        finally { await handle?.close(); }
      }
    };
    await visit(this.root);
  }
  async scan(file, state) {
    const details = await stat(file);
    const identity = String(details.dev) + ':' + String(details.ino) + ':' + String(details.birthtimeMs);
    if (details.size < state.offset || (state.identity && state.identity !== identity)) {
      Object.assign(state, { offset: 0, partial: '', decoder: new StringDecoder('utf8'),
        snapshot: null, task: null, order: 0 });
    }
    state.identity = identity;
    const end = details.size;
    const handle = await open(file, 'r');
    try {
      if (state.offset === 0) {
        const headerBytes = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(headerBytes, 0, headerBytes.length, 0);
        const header = JSON.parse(headerBytes.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
        if (header.type !== 'session_meta' || header.payload?.id?.toLowerCase() !== state.id) {
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
    await this.discover(force || ![...this.files.values()].some((file) => file.id === id));
    let latest = null;
    let task = null;
    let failed = this.indexFailed;
    const modes = [];
    for (const [file, state] of this.files) {
      if (state.id !== id) continue;
      try { await this.scan(file, state); } catch { failed = true; }
      modes.push(state.mode);
      latest = chooseSnapshot(latest, state.snapshot);
      task = chooseTask(task, state.task);
    }
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
