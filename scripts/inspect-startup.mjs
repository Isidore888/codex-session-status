import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFuseWire } from '../src/startup-capabilities.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [appRoot, version] = process.argv.slice(2);
if (!appRoot || !version) throw new Error('app-root-and-version-required');
let fuse;
try { fuse = { verified: true, ...readFuseWire(path.join(appRoot, 'app', 'chrome.dll')) }; }
catch { fuse = { verified: false, reason: 'feature-switch-inspection-failed' }; }
const report = {
  checkedAt: new Date().toISOString(), appRoot, version,
  fuse, installationChanged: false, interceptionInstalled: false,
  directExeAutoLoadVerified: false,
  conclusion: 'No compatible direct-EXE interception has been verified. Do not install an IFEO relay.',
  sources: {
    chromiumIfeo: 'https://chromium.googlesource.com/playground/chromium-org-site/+/refs/heads/main/developers/how-tos/debugging-on-windows/index.md',
    electronFuses: 'https://www.electronjs.org/docs/latest/tutorial/fuses',
    packageDebugging: 'https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ipackagedebugsettings-enabledebugging'
  }
};
const output = path.join(root, 'runtime', 'verification', 'startup-compatibility.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
