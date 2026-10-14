import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime/research/startup-loading-2026-10-11');
const rows=JSON.parse(await readFile(path.join(root,'downloaded-sources.json'),'utf8'));
const results=[];
for(const row of rows){
 if(row.error){results.push({repo:row.repo,file:row.file,matched:false,error:row.error});continue;}
 const data=await readFile(path.join(root,row.repo.replace('/','--'),row.file));
 const meta=JSON.parse(await readFile(path.join(root,row.repo.replace('/','--')+'.json'),'utf8'));
 const expected=row.blobSha||meta.files.find(f=>f.path===row.file)?.sha;
 const actual=createHash('sha1').update(Buffer.from('blob '+data.length+'\0')).update(data).digest('hex');
 results.push({repo:row.repo,file:row.file,commit:row.sha,blob:actual,matched:expected===actual});
}
const report={checkedAt:new Date().toISOString(),repositories:new Set(rows.map(r=>r.repo)).size,files:rows.length,matched:results.filter(r=>r.matched).length,executedUpstreamCode:false,results};
await writeFile(path.join(root,'verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({repositories:report.repositories,files:report.files,matched:report.matched,executedUpstreamCode:false}));
if(report.matched!==report.files)process.exitCode=1;
