import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validBytes = await readFile(new URL('../fixtures/valid.cfb', import.meta.url));

async function setup(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1');
  provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(`${source}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const collect = () => fetch(`${base}/api/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) }).then(reply => reply.json());
  const record = key => fetch(`${base}/api/records/${key}`).then(reply => reply.json());
  return { base, source, control, collect, record };
}

const outcome = (summary, path) => summary.deliveries[0].outcomes.find(item => item.objectPath === path);

test('采集确认流的目录项与源字节证据，身份按来源隔离', async context => {
  const { collect, record } = await setup(context);
  const summary = await collect();
  assert.equal(summary.deliveries.length, 1);
  const paths = summary.deliveries[0].outcomes.map(item => item.objectPath).sort();
  assert.deepEqual(paths, ['/', '/ObjectPool/Summary', '/ObjectPool/Workbook', '/Properties/Summary']);

  const workbook = await record(outcome(summary, '/ObjectPool/Workbook').receipt);
  assert.equal(workbook.source, summary.source);
  assert.deepEqual(workbook.identity, { delivery: 'cabinet-a', objectPath: '/ObjectPool/Workbook' });
  const data = workbook.versions[0].data;
  assert.equal(data.status, 'confirmed');
  assert.equal(data.entry.id, 3);
  assert.equal(data.entry.name, 'Workbook');
  assert.equal(data.chain, 'regular');
  assert.deepEqual(data.sectors, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(data.ranges[0], { offset: 512, length: 512 });
  assert.equal(data.contentSha256, sha256(validBytes.subarray(512, 512 + 4096)));
  assert.equal(data.deliverySha256, sha256(validBytes));

  const mini = await record(outcome(summary, '/Properties/Summary').receipt);
  const miniData = mini.versions[0].data;
  assert.equal(miniData.chain, 'mini');
  assert.deepEqual(miniData.ranges, [{ offset: 4672, length: 64 }]);
  assert.equal(miniData.contentSha256, sha256(validBytes.subarray(4672, 4692)));

  const manifest = await record(outcome(summary, '/').receipt);
  assert.equal(manifest.versions[0].data.entries.length, 8);
  assert.equal(manifest.versions[0].data.entries[6].path, '/Properties/Summary');
  assert.deepEqual(manifest.versions[0].data.problems, []);
});

test('重采同一原件复用对象身份与版本', async context => {
  const { base, collect } = await setup(context);
  const first = await collect();
  const second = await collect();
  assert.ok(second.deliveries[0].outcomes.every(item => item.duplicate));
  assert.deepEqual(
    second.deliveries[0].outcomes.map(item => item.receipt).sort(),
    first.deliveries[0].outcomes.map(item => item.receipt).sort(),
  );
  const records = await (await fetch(`${base}/api/records`)).json();
  assert.equal(records.length, 4);
  assert.ok(records.every(record => record.versions.length === 1));
});

test('链循环交付件只隔离对应流，其余流照常归档', async context => {
  const { control, collect, record } = await setup(context);
  await control({ mode: 'chain-cycle' });
  const summary = await collect();
  assert.equal(outcome(summary, '/ObjectPool/Workbook').status, 'unconfirmed');
  assert.equal(outcome(summary, '/ObjectPool/Summary').status, 'confirmed');
  assert.equal(outcome(summary, '/Properties/Summary').status, 'confirmed');
  const workbook = await record(outcome(summary, '/ObjectPool/Workbook').receipt);
  const data = workbook.versions[0].data;
  assert.equal(data.problem.reason, 'chain-cycle');
  assert.equal(data.contentSha256, null);
  assert.deepEqual(data.sectors, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('目录环使不可达对象缺席并在清单留证', async context => {
  const { control, collect, record } = await setup(context);
  await control({ mode: 'directory-cycle' });
  const summary = await collect();
  const paths = summary.deliveries[0].outcomes.map(item => item.objectPath).sort();
  assert.deepEqual(paths, ['/', '/ObjectPool/Summary', '/Properties/Summary']);
  const manifest = await record(outcome(summary, '/').receipt);
  const reasons = manifest.versions[0].data.problems.map(problem => problem.reason);
  assert.ok(reasons.includes('directory-cycle'));
  assert.ok(reasons.includes('entry-unreachable'));
});

test('争用扇区的对象都不确认，供方更换后身份延续且旧版本保留', async context => {
  const { control, collect, record } = await setup(context);
  await control({ mode: 'shared-sector' });
  const exposed = await collect();
  assert.equal(outcome(exposed, '/ObjectPool/Workbook').status, 'unconfirmed');
  assert.equal(outcome(exposed, '/ObjectPool/OtherWorkbook').status, 'unconfirmed');
  assert.equal(outcome(exposed, '/ObjectPool/Summary').status, 'confirmed');

  await control({ mode: 'valid', revision: 2 });
  const restored = await collect();
  const before = outcome(exposed, '/ObjectPool/Workbook');
  const after = outcome(restored, '/ObjectPool/Workbook');
  assert.equal(after.receipt, before.receipt, '同一来源同一对象路径保持同一身份');
  assert.equal(after.status, 'confirmed');
  const workbook = await record(after.receipt);
  assert.equal(workbook.versions.length, 2);
  assert.equal(workbook.versions[0].data.status, 'unconfirmed');
  assert.equal(workbook.versions[1].data.status, 'confirmed');
});

test('领取按登记的目录位置回源并绑定交付版本', async context => {
  const { base, control, collect } = await setup(context);
  const summary = await collect();
  const workbook = outcome(summary, '/ObjectPool/Workbook');
  const claim = body => fetch(`${base}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const ok = await claim({ receipt: workbook.receipt, version: workbook.version });
  assert.equal(ok.status, 200);
  const confirmed = await ok.json();
  assert.equal(confirmed.verified, true);
  assert.equal(confirmed.size, 4096);
  assert.equal(confirmed.sha256, sha256(validBytes.subarray(512, 512 + 4096)));

  const mini = outcome(summary, '/Properties/Summary');
  const miniClaim = await (await claim({ receipt: mini.receipt, version: mini.version })).json();
  assert.equal(miniClaim.size, 20);
  assert.equal(miniClaim.sha256, sha256(validBytes.subarray(4672, 4692)));

  await control({ revision: 2 });
  const stale = await claim({ receipt: workbook.receipt, version: workbook.version });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /交付件已更换/);

  assert.equal((await claim({ receipt: '0'.repeat(64), version: 1 })).status, 404);
  assert.equal((await claim({ receipt: workbook.receipt, version: 99 })).status, 404);
});

test('未确认版本与人工收件不能按目录位置领取', async context => {
  const { base, control, collect } = await setup(context);
  await control({ mode: 'chain-cycle' });
  const summary = await collect();
  const workbook = outcome(summary, '/ObjectPool/Workbook');
  const claim = body => fetch(`${base}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await claim({ receipt: workbook.receipt, version: workbook.version })).status, 422);

  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const manual = await (await fetch(`${base}/api/manual`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) })).json();
  assert.equal((await claim({ receipt: manual.receipt, version: 1 })).status, 422);
});
