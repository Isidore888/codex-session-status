import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UUID, readQuota } from './metrics.mjs';
import { SessionStore } from './sessions.mjs';

export function identifyMode(originator) {
  if (originator === 'codex_work_desktop') return 'Work';
  if (originator === 'Codex Desktop') return 'Codex';
  return null;
}

// These keys are accepted by the installed official codex-app-tools MCP adapter.
export function bindSession(args = {}, meta = {}) {
  const candidates = [];
  for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
    if (typeof meta[key] === 'string' && UUID.test(meta[key])) candidates.push(meta[key].toLowerCase());
  }
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string' && turn.length < 4096) { try { turn = JSON.parse(turn); } catch { turn = null; } }
  if (typeof turn?.thread_id === 'string' && UUID.test(turn.thread_id)) candidates.push(turn.thread_id.toLowerCase());
  if (typeof meta.thread?.id === 'string' && UUID.test(meta.thread.id)) candidates.push(meta.thread.id.toLowerCase());
  const unique = [...new Set(candidates)];
  if (unique.length > 1) return { sessionId: null, source: 'conflicting-host-context' };
  if (unique.length === 1) return { sessionId: unique[0], source: 'host-thread-metadata' };
  if (typeof args.session_id === 'string' && UUID.test(args.session_id)) {
    return { sessionId: args.session_id.toLowerCase(), source: 'explicit-session' };
  }
  // The anonymized openai/session and process-wide CODEX_THREAD_ID are NOT fallbacks.
  return { sessionId: null, source: 'unavailable' };
}

export function readThreadContext(databasePath, sessionId) {
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const row = db.prepare('SELECT id, originator FROM threads WHERE id = ? LIMIT 1').get(sessionId);
    if (!row) return { mode: null, stale: false, knownSession: false };
    return { mode: identifyMode(row.originator), stale: false, knownSession: true };
  } catch { return { mode: null, stale: true, knownSession: false }; }
  finally { db?.close(); }
}

export class StatusService {
  constructor({ codexRoot, dataDirectory, quotaReader = null, clock = Date.now }) {
    this.sessions = new SessionStore(path.join(codexRoot, 'sessions'));
    this.database = path.join(codexRoot, 'state_5.sqlite');
    this.dataDirectory = dataDirectory;
    this.quotaReader = quotaReader;
    this.clock = clock;
    this.quota = { value: null, stale: false, updatedAt: null, source: 'unavailable' };
    this.quotaAttemptedAt = null;
    this.quotaTask = null;
    this.sessionTasks = new Map();
  }
  async readQuota(sessionId, mode) {
    const now = this.clock();
    if (this.quotaAttemptedAt !== null && now - this.quotaAttemptedAt < 60000) {
      return this.quotaTask ?? this.quotaView();
    }
    this.quotaAttemptedAt = now;
    this.quotaTask = (async () => {
      try {
        if (!this.quotaReader) throw new Error('quota-channel-unavailable');
        const result = await this.quotaReader(sessionId, mode);
        this.quota = { value: readQuota(result), stale: false, updatedAt: this.clock(), source: 'desktop-api' };
      } catch {
        if (!this.quota.value) {
          try {
            const seed = JSON.parse(await readFile(path.join(this.dataDirectory, 'quota.json'), 'utf8'));
            const age = this.clock() - seed.updatedAt;
            const value = seed.value;
            if (seed.source === 'desktop-api' && Number.isSafeInteger(seed.updatedAt) && age >= 0
              && value && (value.remainingPercent === null || (Number.isFinite(value.remainingPercent)
                && value.remainingPercent >= 0 && value.remainingPercent <= 100))
              && (value.resetsAt === null || (Number.isSafeInteger(value.resetsAt) && value.resetsAt > 0))) {
              this.quota = { value: { remainingPercent: value.remainingPercent, resetsAt: value.resetsAt },
                updatedAt: seed.updatedAt, stale: true, source: 'desktop-api-snapshot' };
            }
          } catch { /* No quota credentials, alternate period or guessed value. */ }
        }
        this.quota.stale = true;
      }
      return this.quotaView();
    })().finally(() => { this.quotaTask = null; });
    return this.quotaTask;
  }
  quotaView() {
    return { ...this.quota, stale: this.quota.stale
      || (this.quota.updatedAt != null && this.clock() - this.quota.updatedAt >= 60000) };
  }
  async read(args, meta) {
    const binding = bindSession(args, meta);
    if (!binding.sessionId) return { binding, session: { value: null, stale: false },
      quota: { value: null, stale: false, updatedAt: null, source: 'unavailable' }, mode: { value: null, stale: false } };
    const context = readThreadContext(this.database, binding.sessionId);
    // Incremental reads of the same file must not race across simultaneous widget polls.
    let task = this.sessionTasks.get(binding.sessionId);
    if (!task) {
      task = this.sessions.read(binding.sessionId).finally(() => this.sessionTasks.delete(binding.sessionId));
      this.sessionTasks.set(binding.sessionId, task);
    }
    const [session, quota] = await Promise.all([task, this.readQuota(binding.sessionId, context.mode)]);
    return { binding, session, quota, mode: { value: context.mode, stale: context.stale } };
  }
}
