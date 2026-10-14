import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../src/sessions.mjs';
import { UUID } from '../src/metrics.mjs';
const [threadId] = process.argv.slice(2);
if (!UUID.test(threadId || '')) throw new Error('Provide a valid session ID');
const output = path.resolve('runtime', 'verification');
await mkdir(output, { recursive: true });
const store = new SessionStore(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'));
const session = await store.read(threadId);
const report = { checkedAt: new Date().toISOString(), session: session.value, sessionStale: session.stale,
  quotaAcceptance: 'requires-live-desktop-CDP', rendererAcceptance: 'pending' };
await writeFile(path.join(output, 'live-data.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!session.value) process.exitCode = 1;
