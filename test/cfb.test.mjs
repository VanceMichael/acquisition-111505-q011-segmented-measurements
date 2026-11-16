import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseCompoundFile } from '../src/cfb.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}.cfb`, import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const at = (bytes, offset, length) => bytes.subarray(offset, offset + length);

test('有效交付件还原目录层级、两类分配链与源字节范围', async () => {
  const bytes = await fixture('valid');
  const parsed = parseCompoundFile(bytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.entries.length, 8);
  assert.equal(parsed.entries[1].path, '/ObjectPool');
  assert.equal(parsed.entries[6].path, '/Properties/Summary');
  const byPath = Object.fromEntries(parsed.streams.map(stream => [stream.path, stream]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/ObjectPool/Summary', '/ObjectPool/Workbook', '/Properties/Summary']);

  const workbook = byPath['/ObjectPool/Workbook'];
  assert.equal(workbook.status, 'confirmed');
  assert.equal(workbook.chain, 'regular');
  assert.equal(workbook.entryId, 3);
  assert.deepEqual(workbook.sectors, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(workbook.ranges[0], { offset: 512, length: 512 });
  assert.equal(workbook.size, 4096);
  assert.equal(workbook.sha256, sha256(at(bytes, 512, 4096)));
  assert.deepEqual(workbook.content, at(bytes, 512, 4096));

  const poolSummary = byPath['/ObjectPool/Summary'];
  assert.equal(poolSummary.chain, 'mini');
  assert.equal(poolSummary.entryId, 2);
  assert.deepEqual(poolSummary.sectors, [0]);
  assert.deepEqual(poolSummary.ranges, [{ offset: 4608, length: 64 }]);
  assert.equal(poolSummary.sha256, sha256(at(bytes, 4608, 24)));

  const propSummary = byPath['/Properties/Summary'];
  assert.equal(propSummary.chain, 'mini');
  assert.deepEqual(propSummary.ranges, [{ offset: 4672, length: 64 }]);
  assert.equal(propSummary.sha256, sha256(at(bytes, 4672, 20)));
  assert.notEqual(poolSummary.sha256, propSummary.sha256, '同名流分属不同存储，内容各自确认');
});

test('链循环只使对应流未确认，其余流独立确认', async () => {
  const parsed = parseCompoundFile(await fixture('chain-cycle'));
  const byPath = Object.fromEntries(parsed.streams.map(stream => [stream.path, stream]));
  const workbook = byPath['/ObjectPool/Workbook'];
  assert.equal(workbook.status, 'unconfirmed');
  assert.equal(workbook.problem.reason, 'chain-cycle');
  assert.deepEqual(workbook.sectors, [0, 1, 2, 3, 4, 5, 6, 7], '保留已走链作为证据');
  assert.equal(workbook.content, null, '不按剩余字节猜出内容');
  assert.equal(workbook.sha256, null);
  assert.equal(byPath['/ObjectPool/Summary'].status, 'confirmed');
  assert.equal(byPath['/Properties/Summary'].status, 'confirmed');
});

test('目录关系损坏时不可达对象不领取，可达流不受影响', async () => {
  const parsed = parseCompoundFile(await fixture('directory-cycle'));
  const reasons = parsed.problems.map(problem => problem.reason);
  assert.ok(reasons.includes('directory-cycle'));
  assert.ok(reasons.includes('entry-unreachable'));
  const unreachable = parsed.problems.find(problem => problem.reason === 'entry-unreachable');
  assert.equal(unreachable.entry, 3);
  assert.deepEqual(parsed.streams.map(stream => stream.path).sort(), ['/ObjectPool/Summary', '/Properties/Summary']);
  assert.ok(parsed.streams.every(stream => stream.status === 'confirmed'));
});

test('争用同一组扇区的多个对象都不可确认', async () => {
  const parsed = parseCompoundFile(await fixture('shared-sector'));
  const byPath = Object.fromEntries(parsed.streams.map(stream => [stream.path, stream]));
  assert.equal(byPath['/ObjectPool/Workbook'].status, 'unconfirmed');
  assert.equal(byPath['/ObjectPool/Workbook'].problem.reason, 'sector-shared');
  assert.equal(byPath['/ObjectPool/OtherWorkbook'].status, 'unconfirmed');
  assert.equal(byPath['/ObjectPool/OtherWorkbook'].problem.reason, 'sector-shared');
  assert.equal(byPath['/ObjectPool/Summary'].status, 'confirmed');
  assert.equal(byPath['/Properties/Summary'].status, 'confirmed');
});

test('非复合文件与截断文件不产生任何已确认内容', async () => {
  const foreign = parseCompoundFile(Buffer.alloc(1024));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.problems[0].reason, 'bad-signature');
  const truncated = parseCompoundFile((await fixture('valid')).subarray(0, 3000));
  assert.equal(truncated.ok, true);
  assert.equal(truncated.streams.length, 0);
  assert.ok(truncated.problems.length > 0);
});
