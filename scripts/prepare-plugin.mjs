import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const plugin=path.join(root,'plugin');
await mkdir(path.join(plugin,'lib'),{recursive:true});
for(const name of ['metrics.mjs','sessions.mjs','mode.mjs','task-time.mjs'])await copyFile(path.join(root,'src',name),path.join(plugin,'lib',name));
const environment=JSON.parse(await readFile(path.join(root,'runtime','environment.json'),'utf8'));
const mcp={mcpServers:{session_status:{command:environment.node,args:[path.join(plugin,'server.mjs')],
  env_vars:['CODEX_APP_TOOLS_PIPE_PATH','CODEX_APP_TOOLS_CALLER_HOST_ID'],
  env:{SESSION_STATUS_DATA_DIR:path.join(root,'runtime','plugin')},startup_timeout_sec:10,tool_timeout_sec:15}}};
await writeFile(path.join(plugin,'.mcp.json'),JSON.stringify(mcp,null,2)+'\n');
console.log('PASS: self-contained local plugin prepared');
