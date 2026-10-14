import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StatusService } from '../plugin/lib/status.mjs';
import { DesktopQuotaReader } from '../plugin/lib/desktop-quota.mjs';
import { UUID } from '../src/metrics.mjs';
const id=process.env.CODEX_THREAD_ID;
if(!id||!UUID.test(id))throw new Error('current-session-id-unavailable');
const native=new DesktopQuotaReader(process.env.CODEX_APP_TOOLS_PIPE_PATH);
let quotaProbe='not-run';
const service=new StatusService({codexRoot:path.join(os.homedir(),'.codex'),dataDirectory:path.resolve('runtime/plugin'),
  quotaReader:async(session,mode)=>{try{const value=await native.read(session,mode);quotaProbe='passed';return value}
    catch(error){quotaProbe=error.message;throw error}}});
const data=await service.read({}, {'x-codex-turn-metadata':JSON.stringify({thread_id:id})});
await mkdir('runtime/verification',{recursive:true});
await writeFile('runtime/verification/plugin-live.json',JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({quotaProbe,catalogMatched:Boolean(native.tool),failureHints:native.lastFailureHints,...data},null,2));
