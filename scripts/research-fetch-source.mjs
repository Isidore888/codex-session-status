import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime/research/startup-loading-2026-10-11');
const choices={
 'Finderchangchang/codex-autoskin':['scripts/install-dream-skin.ps1','scripts/watch-dream-skin.ps1','scripts/start-dream-skin.ps1','scripts/injector.mjs','assets/renderer-inject.js'],
 'serein431/Codex-Mate':['codex_mate/autostart.py','codex_mate/watcher.py','codex_mate/launcher.py','codex_mate/windows_installer.py','README.md','codex_mate/inject/renderer-inject.js'],
 'CCDawn/Codex-Dynamic-Skin':['windows/scripts/install-dream-skin.ps1','windows/scripts/start-dream-skin.ps1','windows/scripts/injector.mjs','docs/install-windows.md'],
 'HeiGeAi/heige-codex-skin-studio':['scripts/windows/install.ps1','scripts/windows/start-session-controller.ps1','scripts/windows/lib/restart-into-cdp.ps1','scripts/windows/lib/start-menu.ps1','scripts/windows/lib/common.ps1','scripts/windows/lib/scheduled-task.ps1','scripts/windows/apply.ps1','src/cli.mjs','src/controller.mjs','src/injector.mjs','README.md'],
 'KevinKE93/Codex-Monitor':['scripts/install_launch_agent.sh','scripts/start_codex_monitor.sh','scripts/reopen_codex_with_debug.sh','scripts/context_token_injector.py'],
 'JiaYang-BUAA/Codex-Desktop-Usage-Monitor-Windows':['scripts/install-monitor-launcher.ps1','scripts/launch-codex-monitor.ps1','scripts/monitor-utils.ps1','scripts/injector.mjs','scripts/current-thread.mjs','assets/usage-inject.js'],
 'TonyNa-code/codex-background-theme':['src/patch-codex-background.js','docs/WINDOWS.md','scripts/codex-background-reapply.ps1']
};
const rows=[];
const previous=JSON.parse(await readFile(path.join(root,'downloaded-sources.json'),'utf8').catch(()=>'[]'));
for(const [repo,files] of Object.entries(choices)){
 const info=JSON.parse(await readFile(path.join(root,repo.replace('/','--')+'.json'),'utf8'));
 const fetched=await Promise.all(files.map(async file=>{
  const url='https://raw.githubusercontent.com/'+repo+'/'+info.sha+'/'+file;
  const saved=previous.find(r=>r.repo===repo&&r.file===file&&!r.error);
  if(saved)return saved;
  const apiUrl='https://api.github.com/repos/'+repo+'/contents/'+file+'?ref='+info.sha;
  try{const response=await fetch(apiUrl,{headers:{'User-Agent':'local-startup-source-review'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('HTTP '+response.status);const blob=await response.json();if(blob.encoding!=='base64'||blob.size>2000000)throw new Error('source-encoding-size');const text=Buffer.from(blob.content,'base64').toString('utf8');const target=path.resolve(root,repo.replace('/','--'),file);if(!target.startsWith(root+path.sep))throw new Error('invalid-path');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);return {repo,sha:info.sha,file,url,apiUrl,blobSha:blob.sha,lines:text.split('\n').length,bytes:Buffer.byteLength(text),priorFailure:previous.find(r=>r.repo===repo&&r.file===file)?.error};}catch(e){return {repo,file,url,apiUrl,error:e.message};}
 }));rows.push(...fetched);
}
await writeFile(path.join(root,'downloaded-sources.json'),JSON.stringify(rows,null,2)+'\n');
console.log(JSON.stringify({files:rows.length,fetched:rows.filter(r=>!r.error).length,failures:rows.filter(r=>r.error).map(r=>({repo:r.repo,file:r.file,error:r.error}))}));
