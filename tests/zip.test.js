import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../src/zip.js';
test('ZIP records contain valid lengths, filenames, CRC32 and a central directory', async () => {
  const bytes = new Uint8Array(await createZip({ 'safe.har': '123456789', 'issue.md': '你好' }).arrayBuffer());
  const v = new DataView(bytes.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint32(14, true), 0xcbf43926);
  assert.equal(v.getUint32(18, true), 9);
  const tail = bytes.length - 22;
  assert.equal(v.getUint32(tail, true), 0x06054b50);
  assert.equal(v.getUint16(tail + 10, true), 2);
  const central = v.getUint32(tail + 16, true);
  assert.equal(v.getUint32(central, true), 0x02014b50);
  assert.equal(new TextDecoder().decode(bytes.slice(30, 38)), 'safe.har');
  assert.throws(() => createZip({ '../secret': 'no' }), /simple names/);
});
