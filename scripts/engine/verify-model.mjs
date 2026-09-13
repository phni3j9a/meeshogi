import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const expected = {
  size: 1_305_356,
  magic: Buffer.from('SEKIRW01', 'ascii'),
  sha256: '807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab',
};
const modelPath = resolve(process.argv[2] ?? 'assets/model/c-leaf-wrm-seed42.bin');
const bytes = readFileSync(modelPath);
const digest = createHash('sha256').update(bytes).digest('hex');
if (bytes.length !== expected.size) throw new Error(`model size mismatch: expected ${expected.size}, got ${bytes.length}`);
if (!bytes.subarray(0, expected.magic.length).equals(expected.magic)) throw new Error('model magic mismatch: expected SEKIRW01');
if (digest !== expected.sha256) throw new Error(`model SHA-256 mismatch: expected ${expected.sha256}, got ${digest}`);
console.log(JSON.stringify({ path: modelPath, size: bytes.length, sha256: digest }));
