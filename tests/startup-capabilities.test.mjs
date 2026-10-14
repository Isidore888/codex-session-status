import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFuseWire } from '../src/startup-capabilities.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
mkdirSync(runtime, { recursive: true });
const marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
function withFixture(bytes, check) {
  const directory = mkdtempSync(path.join(runtime, 'startup-test-'));
  const file = path.join(directory, 'fixture.bin');
  try { writeFileSync(file, bytes); check(file); }
  finally { unlinkSync(file); rmdirSync(directory); }
}
function wire(version = 1, states = '010011001') {
  return Buffer.concat([marker, Buffer.from([version, states.length]), Buffer.from(states)]);
}
test('reads split markers and preserves feature order', () => {
  withFixture(Buffer.concat([Buffer.alloc(37), wire(), Buffer.alloc(41)]), file => {
    const result = readFuseWire(file, 7);
    assert.equal(result.offset, 37);
    assert.equal(result.features.nodeOptions, 'disabled');
    assert.equal(result.features.embeddedAsarIntegrityValidation, 'enabled');
    assert.equal(result.features.onlyLoadAppFromAsar, 'enabled');
  });
});
test('removed switches are not treated as enabled', () => {
  withFixture(wire(1, '01r011001'), file =>
    assert.equal(readFuseWire(file, 13).features.nodeOptions, 'removed'));
});
test('rejects missing, duplicated and unknown-version wires', () => {
  for (const [bytes, message] of [[Buffer.alloc(50), 'fuse-wire-not-found'],
    [Buffer.concat([wire(), wire()]), 'ambiguous-fuse-wire'], [wire(2), 'unsupported-fuse-version']]) {
    withFixture(bytes, file => assert.throws(() => readFuseWire(file, 17), new RegExp(message)));
  }
});
test('rejects truncated wire and invalid states', () => {
  withFixture(wire().subarray(0, -1), file =>
    assert.throws(() => readFuseWire(file, 11), /truncated-fuse-wire/));
  withFixture(wire(1, '01x011001'), file =>
    assert.throws(() => readFuseWire(file, 11), /invalid-fuse-state/));
});
