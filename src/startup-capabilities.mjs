import { openSync, readSync, closeSync } from 'node:fs';

const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const names = ['runAsNode', 'cookieEncryption', 'nodeOptions', 'nodeCliInspect',
  'embeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot', 'grantFileProtocolExtraPrivileges'];

// Read only the packaged feature switches. Never patch binaries or inspect user data.
export function readFuseWire(file, chunkSize = 1024 * 1024) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('invalid-chunk-size');
  const fd = openSync(file, 'r');
  const seen = new Map();
  let offset = 0, tail = Buffer.alloc(0), incomplete = false;
  try {
    while (true) {
      const chunk = Buffer.alloc(chunkSize);
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      const data = Buffer.concat([tail, chunk.subarray(0, count)]);
      const base = offset - tail.length;
      incomplete = false;
      for (let pos = data.indexOf(sentinel); pos !== -1; pos = data.indexOf(sentinel, pos + 1)) {
        const absolute = base + pos;
        if (seen.has(absolute)) continue;
        const header = pos + sentinel.length;
        if (header + 2 > data.length) { incomplete = true; continue; }
        const version = data[header], length = data[header + 1];
        if (version !== 1) throw new Error('unsupported-fuse-version');
        if (length < names.length) throw new Error('incomplete-fuse-schema');
        if (header + 2 + length > data.length) { incomplete = true; continue; }
        const wire = data.subarray(header + 2, header + 2 + length).toString('ascii');
        if (!/^[01r]+$/.test(wire)) throw new Error('invalid-fuse-state');
        seen.set(absolute, { version, length, offset: absolute,
          features: Object.fromEntries(names.map((name, index) =>
            [name, wire[index] === '1' ? 'enabled' : wire[index] === '0' ? 'disabled' : 'removed'])) });
      }
      if (count === 0) break;
      offset += count;
      tail = data.subarray(Math.max(0, data.length - sentinel.length - 2 - 255));
    }
  } finally { closeSync(fd); }
  if (incomplete) throw new Error('truncated-fuse-wire');
  if (seen.size !== 1) throw new Error(seen.size ? 'ambiguous-fuse-wire' : 'fuse-wire-not-found');
  return [...seen.values()][0];
}
