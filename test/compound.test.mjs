import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCompound, sourceRanges, CompoundError } from '../src/compound.mjs';

const fixture = async name => readFile(new URL(`../fixtures/${name}.cfb`, import.meta.url));
const byPath = parsed => Object.fromEntries(parsed.objects.map(object => [object.path || `#${object.entryIndex}`, object]));

test('普通流与短流分别沿 FAT 与 MiniFAT 取证', async () => {
  const parsed = parseCompound(await fixture('valid'));
  const objects = byPath(parsed);
  assert.deepEqual(objects['/ObjectPool/Workbook'].allocation.sectors, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(objects['/ObjectPool/Workbook'].allocation.kind, 'fat');
  assert.deepEqual(objects['/ObjectPool/Summary'].allocation.sectors, [0]);
  assert.equal(objects['/ObjectPool/Summary'].allocation.kind, 'mini');
  assert.deepEqual(objects['/Properties/Summary'].allocation.sectors, [1]);
  // Root's own stream is regular even though it is small.
  assert.equal(objects['/'].kind, 'root');
  assert.deepEqual(objects['/'].miniStream.sectors, [8]);

  const workbook = objects['/ObjectPool/Workbook'];
  assert.deepEqual(workbook.allocation.contentByteRanges.map(range => range.offset), [512, 1024, 1536, 2048, 2560, 3072, 3584, 4096]);
  const summary = objects['/ObjectPool/Summary'];
  assert.deepEqual(summary.allocation.contentByteRanges.map(range => range.offset), [(8 + 1) * 512]);
  assert.equal(summary.content.length, 24);
  assert.equal(summary.content.toString(), 'ObjectPool local summary');
  assert.equal(objects['/Properties/Summary'].content.toString(), 'Properties summary!!');
});

test('目录按存储层级给出路径，同名流不会合并', async () => {
  const parsed = parseCompound(await fixture('valid'));
  const summaries = parsed.objects.filter(object => object.name === 'Summary');
  assert.deepEqual(summaries.map(object => object.path).sort(), ['/ObjectPool/Summary', '/Properties/Summary']);
  assert.equal(new Set(summaries.map(object => object.contentSha256)).size, 2);
  for (const object of summaries) {
    assert.equal(object.directoryEntry.name, 'Summary');
    assert.equal(typeof object.directoryEntry.offset, 'number');
  }
  // Empty directory slots are not content and are not reported as objects.
  assert.equal(parsed.objects.some(object => object.kind === 'stream' && object.size === 0 && object.name === ''), false);
  assert.deepEqual(parsed.directory.unplaced, []);
});

test('链循环只否定该流，其他流保持已确认', async () => {
  const parsed = parseCompound(await fixture('chain-cycle'));
  const objects = byPath(parsed);
  assert.equal(objects['/ObjectPool/Workbook'].status, 'unconfirmed');
  assert.deepEqual(objects['/ObjectPool/Workbook'].issues, ['cyclic-chain']);
  assert.equal(objects['/ObjectPool/Workbook'].contentSha256, null);
  assert.equal(objects['/ObjectPool/Summary'].contentSha256, byPath(parseCompound(await fixture('valid')))['/ObjectPool/Summary'].contentSha256);
  assert.equal(objects['/Properties/Summary'].status, 'confirmed');
  const issue = parsed.issues.find(item => item.code === 'cyclic-chain');
  assert.equal(issue.entryIndex, 3);
  assert.equal(issue.path, '/ObjectPool/Workbook');
  assert.throws(() => sourceRanges(parsed, 3), error => error instanceof CompoundError && error.code === 'unconfirmed-object');
});

test('目录关系损坏时未归属对象只留证据，其他存储不受牵连', async () => {
  const parsed = parseCompound(await fixture('directory-cycle'));
  const objects = byPath(parsed);
  assert.equal(objects['/Properties/Summary'].status, 'confirmed');
  assert.equal(objects['/ObjectPool'].status, 'broken');
  const unplaced = parsed.objects.filter(object => object.path === null && object.kind === 'stream');
  assert.deepEqual(unplaced.map(object => object.entryIndex).sort(), [2, 3]);
  assert.equal(unplaced.every(object => object.status === 'unconfirmed' && object.contentSha256 === null), true);
  assert.deepEqual(parsed.directory.unplaced, [2, 3]);
  const issue = parsed.issues.find(item => item.code === 'cyclic-directory');
  assert.equal(issue.path, '/ObjectPool');
  assert.ok(parsed.issues.some(item => item.code === 'directory-unresolved' && item.entryIndex === 3));
  assert.throws(() => sourceRanges(parsed, 2), error => error.code === 'unconfirmed-object');
});

test('扇区争用时双方都未确认并保留双方目录证据', async () => {
  const parsed = parseCompound(await fixture('shared-sector'));
  const objects = byPath(parsed);
  assert.equal(objects['/ObjectPool/Workbook'].status, 'unconfirmed');
  assert.equal(objects['/ObjectPool/OtherWorkbook'].status, 'unconfirmed');
  assert.deepEqual(objects['/ObjectPool/Workbook'].issues, ['shared-allocation']);
  const conflict = parsed.issues.find(item => item.code === 'shared-allocation');
  assert.deepEqual(conflict.evidence.entries, [3, 7]);
  assert.deepEqual(conflict.evidence.paths, ['/ObjectPool/Workbook', '/ObjectPool/OtherWorkbook']);
  assert.equal(objects['/ObjectPool/Summary'].status, 'confirmed');
  assert.equal(objects['/Properties/Summary'].status, 'confirmed');
});

test('结构缺陷不会被当成剩余字节的来源', async () => {
  const valid = await fixture('valid');
  const cases = {
    'invalid-signature': bytes => bytes.fill(0, 0, 8),
    'unsupported-version': bytes => bytes.writeUInt16LE(4, 26),
    'unsupported-cutoff': bytes => bytes.writeUInt32LE(512, 56),
    'missing-fat': bytes => bytes.writeUInt32LE(0, 44),
  };
  for (const [code, mutate] of Object.entries(cases)) {
    const bytes = Buffer.from(valid);
    mutate(bytes);
    assert.throws(() => parseCompound(bytes), error => error instanceof CompoundError && error.code === code, code);
  }
  assert.throws(() => parseCompound(valid.subarray(0, 400)), error => error.code === 'truncated-header');
  // A FAT sector that the header lists but the file does not contain is
  // reported as truncation instead of being read past the end.
  const short = Buffer.from(valid.subarray(0, 6000));
  assert.throws(() => parseCompound(short), error => error instanceof CompoundError);
});

test('流长度高于支持范围时不分配也不猜测', async () => {
  const bytes = Buffer.from(await fixture('valid'));
  const entry = (10 + 1) * 512 + 3 * 128;
  bytes.writeBigUInt64LE(0x1_0000_0000n, entry + 120);
  const parsed = parseCompound(bytes);
  const workbook = parsed.objects.find(object => object.entryIndex === 3);
  assert.equal(workbook.status, 'unconfirmed');
  assert.deepEqual(workbook.issues, ['unsupported-stream-size']);
  assert.equal(workbook.size, null);
  assert.equal(workbook.content, null);
});

test('目录环外的目录项超过文件长度时被隔离', async () => {
  const bytes = Buffer.from(await fixture('valid'));
  const root = (10 + 1) * 512;
  bytes.writeUInt32LE(4000, root + 1 * 128 + 76);
  const parsed = parseCompound(bytes);
  // The storage itself is still reachable from the root; only its broken child
  // link is refused, and no stream is invented underneath it.
  const storage = parsed.objects.find(object => object.entryIndex === 1);
  assert.equal(storage.path, '/ObjectPool');
  assert.equal(storage.status, 'broken');
  assert.equal(parsed.objects.some(object => object.path && object.path.startsWith('/ObjectPool/')), false);
  assert.equal(parsed.objects.find(object => object.entryIndex === 3).path, null);
  const issue = parsed.issues.find(item => item.code === 'invalid-directory-link');
  assert.equal(issue.entryIndex, 1);
});
