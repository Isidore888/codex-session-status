// Read-only public-source collection. Downloaded files are evidence, never executed.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime/research/startup-loading-2026-10-11');
const repos=['Finderchangchang/codex-autoskin','serein431/Codex-Mate','CCDawn/Codex-Dynamic-Skin','HeiGeAi/heige-codex-skin-studio','KevinKE93/Codex-Monitor','JiaYang-BUAA/Codex-Desktop-Usage-Monitor-Windows','TonyNa-code/codex-background-theme'];
const request=async url=>{const r=await fetch(url,{headers:{'User-Agent':'local-startup-source-review','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('HTTP '+r.status);const t=await r.text();if(t.length>3000000)throw new Error('source-size-limit');return t;};
await mkdir(root,{recursive:true});
const results=await Promise.all(repos.map(async repo=>{try{const meta=JSON.parse(await request('https://api.github.com/repos/'+repo));const branch=meta.default_branch;const commit=JSON.parse(await request('https://api.github.com/repos/'+repo+'/commits/'+encodeURIComponent(branch)));const sha=commit.sha;if(!/^[0-9a-f]{40}$/.test(sha))throw new Error('invalid-source-revision');const tree=JSON.parse(await request('https://api.github.com/repos/'+repo+'/git/trees/'+sha+'?recursive=1'));const files=tree.tree.filter(x=>x.type==='blob'&&/((install|start|launch|watch|inject|autostart|patch|setup|reopen|reapply|README).*\.(ps1|bat|py|sh|mjs|js|md|command)$|\.plist$)/i.test(x.path)).map(x=>({path:x.path,sha:x.sha,size:x.size}));const record={repo,branch,sha,commitDate:commit.commit.committer.date,truncated:tree.truncated,files};await writeFile(path.join(root,repo.replace('/','--')+'.json'),JSON.stringify(record,null,2)+'\n');return {repo,sha,files:files.map(x=>x.path)};}catch(e){return {repo,error:e.message};}}));
await writeFile(path.join(root,'manifest.json'),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
for(const r of results)console.log(JSON.stringify(r));
