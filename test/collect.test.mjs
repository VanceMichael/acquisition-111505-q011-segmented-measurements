import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { Archive } from '../src/archive.mjs';
import { parseCompound, sourceRanges } from '../src/compound.mjs';

const fixture = async name => readFile(new URL(`../fixtures/${name}.cfb`, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function harness(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1');
  provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(done => intake.close(done)), new Promise(done => provider.close(done))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const collect = body => fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { directory, base, source, collect, control, archive: await new Archive(directory).initialize() };
}

test('合法交付件按目录对象领取同名流，路径与存储层级互不混淆', async context => {
  const { base, source, collect } = await harness(context);
  const reply = await collect({ source });
  assert.equal(reply.status, 201);
  const body = await reply.json();
  assert.equal(body.source, 'auto');
  assert.equal(body.identity.delivery, 'cabinet-a');
  assert.equal(body.identity.origin, source);

  const streams = body.objects.filter(object => object.kind === 'stream' && object.status === 'confirmed');
  assert.deepEqual(streams.map(object => object.path).sort(), ['/ObjectPool/Summary', '/ObjectPool/Workbook', '/Properties/Summary'].sort());
  const byPath = Object.fromEntries(streams.map(object => [object.path, object]));
  assert.equal(byPath['/ObjectPool/Summary'].contentSha256, sha(Buffer.from('ObjectPool local summary')));
  assert.equal(byPath['/Properties/Summary'].contentSha256, sha(Buffer.from('Properties summary!!')));
  assert.equal(byPath['/ObjectPool/Summary'].source.kind, 'mini');
  assert.equal(byPath['/ObjectPool/Workbook'].source.kind, 'fat');
  assert.equal(byPath['/ObjectPool/Workbook'].source.sectors.length, 8);
  assert.equal(byPath['/ObjectPool/Workbook'].size, 4096);
  assert.notEqual(byPath['/ObjectPool/Summary'].contentSha256, byPath['/Properties/Summary'].contentSha256);

  // Same-name objects under different storages stay distinct, and none of the
  // extracted content is interpreted as a macro or embedded object.
  const objectReply = await fetch(`${base}/api/records/${body.receipt}/objects/2`);
  assert.equal(objectReply.status, 200);
  assert.equal(Buffer.from(await objectReply.arrayBuffer()).toString(), 'ObjectPool local summary');
  const otherReply = await fetch(`${base}/api/records/${body.receipt}/objects/6`);
  assert.equal(Buffer.from(await otherReply.arrayBuffer()).toString(), 'Properties summary!!');
});

test('查询回到目录项与实际占用的源字节', async context => {
  const { base, source, collect } = await harness(context);
  const created = await (await collect({ source })).json();
  const original = await fixture('valid');
  const listed = await (await fetch(`${source}/deliveries`)).json();
  assert.equal(listed.deliveries[0].sha256, sha(original));

  const detail = await fetch(`${base}/api/records/${created.receipt}?path=${encodeURIComponent('/ObjectPool/Workbook')}`);
  assert.equal(detail.status, 200);
  const payload = await detail.json();
  assert.equal(payload.object.entryIndex, 3);
  assert.equal(payload.object.directoryEntry.index, 3);
  assert.equal(payload.object.directoryEntry.name, 'Workbook');
  assert.equal(payload.version, 1);

  const sourceReply = await fetch(`${base}/api/records/${created.receipt}/objects/3?format=source`);
  assert.equal(sourceReply.status, 200);
  const slice = Buffer.from(await sourceReply.arrayBuffer());
  assert.equal(slice.length, 4096);
  assert.deepEqual(slice, original.subarray(512, 512 + 4096));
  // A short stream's source bytes are its one 64-byte mini sector, truncated
  // to the declared 24 bytes of business content.
  const miniReply = await fetch(`${base}/api/records/${created.receipt}/objects/2?format=source`);
  const miniSlice = Buffer.from(await miniReply.arrayBuffer());
  assert.equal(miniSlice.length, 24);
  assert.deepEqual(miniSlice, Buffer.from('ObjectPool local summary'));
  assert.equal(sha(slice), sha(Buffer.from('CALIBRATION-LOCAL-'.repeat(4096)).subarray(0, 4096)));

  // Allocation evidence is reproducible from the source version alone.
  const parsed = parseCompound(original);
  const ranges = sourceRanges(parsed, 3);
  assert.deepEqual(ranges.map(range => range.offset), [512, 1024, 1536, 2048, 2560, 3072, 3584, 4096]);
  assert.equal(parsed.objects.find(object => object.entryIndex === 3).allocation.kind, 'fat');
  assert.equal(parsed.objects.find(object => object.entryIndex === 2).allocation.kind, 'mini');
});

test('链循环与目录环只影响相关流，其他可独立确认的流仍保留', async context => {
  const { base, source, collect, control } = await harness(context);

  await control({ mode: 'chain-cycle' });
  const chain = await (await collect({ source })).json();
  const chainObjects = Object.fromEntries(chain.objects.map(object => [object.path || `#${object.entryIndex}`, object]));
  assert.equal(chainObjects['/ObjectPool/Workbook'].status, 'unconfirmed');
  assert.ok(chainObjects['/ObjectPool/Workbook'].issues.includes('cyclic-chain'));
  assert.equal(chainObjects['/ObjectPool/Summary'].status, 'confirmed');
  assert.equal(chainObjects['/Properties/Summary'].status, 'confirmed');
  const broken = await fetch(`${base}/api/records/${chain.receipt}/objects/3`);
  assert.equal(broken.status, 409);
  const empty = await fetch(`${base}/api/records/${chain.receipt}/objects/3?format=source`);
  assert.equal(empty.status, 409);

  await control({ mode: 'directory-cycle' });
  const directory = await (await collect({ source })).json();
  const paths = directory.objects.filter(object => object.kind === 'stream' && object.path).map(object => object.path);
  assert.deepEqual(paths, ['/Properties/Summary']);
  assert.equal(directory.objects.find(object => object.path === '/Properties/Summary').status, 'confirmed');
  const unplaced = directory.objects
    .filter(object => object.kind === 'stream' && object.path === null)
    .sort((a, b) => a.entryIndex - b.entryIndex);
  assert.deepEqual(unplaced.map(object => object.entryIndex), [2, 3]);
  assert.equal(unplaced.every(object => object.status === 'unconfirmed' && object.contentSha256 === null), true);
  assert.ok(directory.issues.some(issue => issue.code === 'cyclic-directory' && issue.path === '/ObjectPool'));
  assert.ok(!directory.objects.some(object => object.kind === 'stream' && object.path && object.path.startsWith('/ObjectPool')));
  const properties = await fetch(`${base}/api/records/${directory.receipt}/objects/6`);
  assert.equal(properties.status, 200);
});

test('多个对象争用扇区时双方都标为未确认，摘要不同的其他流仍可领取', async context => {
  const { base, source, collect } = await harness(context);
  await fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shared-sector' }) });
  const body = await (await collect({ source })).json();
  const workbook = body.objects.find(object => object.path === '/ObjectPool/Workbook');
  const other = body.objects.find(object => object.path === '/ObjectPool/OtherWorkbook');
  assert.equal(workbook.status, 'unconfirmed');
  assert.equal(other.status, 'unconfirmed');
  assert.ok(workbook.issues.includes('shared-allocation'));
  assert.equal(body.objects.find(object => object.path === '/ObjectPool/Summary').status, 'confirmed');
  assert.equal(body.objects.find(object => object.path === '/Properties/Summary').status, 'confirmed');
  const conflict = body.issues.find(issue => issue.code === 'shared-allocation');
  assert.deepEqual(conflict.evidence.owners.map(owner => owner.path).sort(), ['/ObjectPool/OtherWorkbook', '/ObjectPool/Workbook']);
  assert.equal((await fetch(`${base}/api/records/${body.receipt}/objects/7`)).status, 409);
  const summary = await fetch(`${base}/api/records/${body.receipt}/objects/2`);
  assert.equal(summary.status, 200);
});

test('供方更换文件后旧目录位置不能领取新文件', async context => {
  const { base, source, collect, control, directory } = await harness(context);
  const first = await (await collect({ source })).json();
  assert.equal(first.version, 1);

  await control({ revision: 2, mode: 'chain-cycle' });
  const listing = await (await fetch(`${source}/deliveries`)).json();
  const etag = listing.deliveries[0].etag;
  const pinned = await collect({ source, etag: first.delivery.etag });
  assert.equal(pinned.status, 409);
  assert.equal((await pinned.json()).code, 'delivery-changed');

  // Re-collecting the replacement keeps one receipt per source and creates a
  // new version whose directory is parsed from the new bytes.
  const replacement = await collect({ source });
  assert.equal(replacement.status, 201);
  const second = await replacement.json();
  assert.equal(second.receipt, first.receipt);
  assert.equal(second.version, 2);
  assert.notEqual(second.envelope.sha256, first.envelope.sha256);
  const oldKeys = first.objects.filter(object => object.objectKey).map(object => object.objectKey);
  const newKeys = second.objects.filter(object => object.objectKey).map(object => object.objectKey);
  assert.equal(newKeys.some(key => oldKeys.includes(key)), false);
  const oldDetail = await fetch(`${base}/api/records/${first.receipt}?version=1&entryIndex=3`);
  assert.equal(oldDetail.status, 200);
  const oldBody = await oldDetail.json();
  assert.equal(oldBody.data.envelope.sha256, first.envelope.sha256);
  assert.equal(oldBody.data.envelope.sha256, sha(await fixture('valid')));
  assert.equal(oldBody.data.objects.find(object => object.entryIndex === 3).path, '/ObjectPool/Workbook');
  assert.ok(etag);
  assert.ok(directory);
});

test('重采同一原件不生成另一套对象身份', async context => {
  const { source, collect, archive } = await harness(context);
  const first = await (await collect({ source })).json();
  const second = await (await collect({ source })).json();
  assert.equal(second.duplicate, true);
  assert.equal(second.version, first.version);
  assert.equal(second.receipt, first.receipt);
  assert.deepEqual(second.objects.map(object => object.entryIndex), first.objects.map(object => object.entryIndex));
  assert.deepEqual(second.objects.map(object => object.contentSha256), first.objects.map(object => object.contentSha256));

  const [record] = await archive.list();
  assert.equal(record.versions.length, 1);
  assert.equal(record.identity.delivery, 'cabinet-a');
  assert.equal(record.identity.origin, source);
  assert.equal(record.versions[0].data.objects.filter(object => object.kind === 'stream').length, 3);
  assert.equal(record.versions[0].data.objects.filter(object => object.kind === 'stream').every(object => object.objectKey && object.objectKey.length === 64), true);
});

test('重采同一原件即使供方递增修订号也复用同一版本', async context => {
  const { source, collect, control, archive } = await harness(context);
  const first = await (await collect({ source })).json();
  await control({ revision: 5 });
  const again = await (await collect({ source })).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.receipt, first.receipt);
  assert.equal(again.version, first.version);
  assert.deepEqual(again.objects.map(object => object.objectKey), first.objects.map(object => object.objectKey));
  const [record] = await archive.list();
  assert.equal(record.versions.length, 1);
  // The first observation of these bytes is kept; a later revision counter does
  // not fabricate a second version for an unchanged original.
  assert.equal(record.versions[0].data.delivery.version, 1);
});

test('非复合正文与摘要不符时不落收件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-fake-'));
  const intake = await createIntake(directory);
  const payload = Buffer.concat([Buffer.from('not a compound file'), Buffer.alloc(512 - 19)]);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const fake = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://localhost');
    const send = (status, body, headers = {}) => {
      outgoing.writeHead(status, { 'content-type': 'application/json', ...headers });
      outgoing.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/deliveries') {
      return send(200, { deliveries: [{ id: 'fake', version: 1, size: payload.length, sha256, etag: '"fake-1"', href: '/deliveries/fake' }] });
    }
    if (url.pathname === '/deliveries/fake') {
      if (incoming.headers['if-match'] !== '"fake-1"') return send(412, { error: 'changed' });
      outgoing.writeHead(200, { 'content-type': 'application/x-cfb' });
      return outgoing.end(payload);
    }
    return send(404, { error: 'missing' });
  });
  fake.listen(0, '127.0.0.1');
  intake.listen(0, '127.0.0.1');
  await Promise.all([once(fake, 'listening'), once(intake, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections();
    fake.closeAllConnections();
    await Promise.all([new Promise(done => intake.close(done)), new Promise(done => fake.close(done))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${fake.address().port}`;
  const reply = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  assert.equal(reply.status, 422);
  assert.equal((await reply.json()).code, 'invalid-signature');
  const pinned = await fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, sha256: '0'.repeat(64) }) });
  assert.equal(pinned.status, 409);
  assert.equal((await pinned.json()).code, 'delivery-changed');
  const records = await (await fetch(`${base}/api/records`)).json();
  assert.equal(records.length, 0);
});

test('人工收件与自动领取在同一归档共存且身份不混淆', async context => {
  const { base, source, collect } = await harness(context);
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  assert.equal(manual.status, 201);
  const collected = await (await collect({ source })).json();
  const records = await (await fetch(`${base}/api/records`)).json();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.source).sort(), ['auto', 'manual']);
  const auto = records.find(record => record.source === 'auto');
  const manualRecord = records.find(record => record.source === 'manual');
  assert.equal(auto.identity.origin !== undefined, true);
  assert.equal(manualRecord.identity.origin, undefined);
  assert.equal(auto.identity.delivery, collected.identity.delivery);
  const invalid = await collect({ source: 'ftp://example.invalid' });
  assert.equal(invalid.status, 400);
  const unreachable = await collect({ source: 'http://127.0.0.1:1' });
  assert.equal(unreachable.status, 502);
  // A bare body carrying only the source address is accepted as well.
  const bare = await fetch(`${base}/api/collect`, { method: 'POST', body: source });
  assert.equal(bare.status, 201);
  assert.equal((await bare.json()).duplicate, true);
  const malformed = await fetch(`${base}/api/collect`, { method: 'POST', body: 'not a source' });
  assert.equal(malformed.status, 400);
});
