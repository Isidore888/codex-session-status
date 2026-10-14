import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const require=createRequire(import.meta.url);const{chromium}=require(process.argv[2]);
const preview=JSON.parse(await readFile('runtime/plugin/preview.json','utf8'));
const url='http://127.0.0.1:'+preview.port;
const context=await chromium.launchPersistentContext(path.resolve('runtime/verification/plugin-preview-profile'),
  {executablePath:process.argv[3],headless:true,viewport:{width:460,height:240},timezoneId:'Asia/Hong_Kong'});
const page=await context.newPage();
try{
  await page.goto(url);const frame=page.frameLocator('iframe');
  await frame.locator('#mode').getByText('Work',{exact:true}).waitFor();
  const quota=await frame.locator('#remaining').textContent();assert.match(quota,/^\d+(\.\d+)?%$/);
  assert.equal(await frame.locator('.metric').count(),5);
  assert.equal(await frame.locator('.stale').count(),0);
  await page.screenshot({path:'runtime/verification/plugin-real-preview.png'});
  const fields=await frame.locator('dd').allTextContents();
  await writeFile('runtime/verification/plugin-preview.json',JSON.stringify({fields,realData:true,nativePluginAcceptance:false},null,2)+'\n');
  console.log(JSON.stringify({fields,realData:true,nativePluginAcceptance:false}));
}finally{await context.close()}
