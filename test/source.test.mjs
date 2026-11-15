import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createProvider } from '../provider/server.mjs';

async function source(context) {
  const service = createProvider();
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
  });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control };
}

test('目录给出的原件长度、校验及两类流布局可独立核对', async context => {
  const { base } = await source(context);
  const { deliveries: [delivery] } = await (await fetch(base + '/deliveries')).json();
  const body = Buffer.from(await (await fetch(base + delivery.href)).arrayBuffer());
  assert.equal(body.length, delivery.size);
  assert.equal(createHash('sha256').update(body).digest('hex'), delivery.sha256);
  assert.equal(body.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  assert.equal(body.readUInt32LE(48), 10);
  const directory = (10 + 1) * 512;
  assert.equal(body.readUInt32LE(directory + 2 * 128 + 116), 0);
  assert.equal(body.readUInt32LE(directory + 3 * 128 + 116), 0);
  assert.equal(body.readBigUInt64LE(directory + 2 * 128 + 120), 24n);
  assert.equal(body.readBigUInt64LE(directory + 3 * 128 + 120), 4096n);
  assert.match(body.subarray((8 + 1) * 512, (8 + 1) * 512 + 24).toString(), /ObjectPool/);
});

test('来源范围读取绑定 ETag，更换版本不默默重用偏移', async context => {
  const { base, control } = await source(context);
  const { deliveries: [delivery] } = await (await fetch(base + '/deliveries')).json();
  const reply = await fetch(base + delivery.href, { headers: { range: 'bytes=0-7', 'if-match': delivery.etag } });
  assert.equal(reply.status, 206);
  assert.equal(reply.headers.get('content-range'), `bytes 0-7/${delivery.size}`);
  assert.equal((await reply.arrayBuffer()).byteLength, 8);
  await control({ revision: 2 });
  assert.equal((await fetch(base + delivery.href, { headers: { 'if-match': delivery.etag } })).status, 412);
});

test('来源分别保留普通流链循环、目录环与交叉分配情景', async context => {
  const { base, control } = await source(context);
  await control({ mode: 'chain-cycle' });
  let body = Buffer.from(await (await fetch(base + '/deliveries/cabinet-a')).arrayBuffer());
  assert.equal(body.readUInt32LE(13 * 512 + 7 * 4), 0);
  await control({ mode: 'directory-cycle' });
  body = Buffer.from(await (await fetch(base + '/deliveries/cabinet-a')).arrayBuffer());
  assert.equal(body.readUInt32LE(11 * 512 + 2 * 128 + 72), 1);
  await control({ mode: 'shared-sector' });
  body = Buffer.from(await (await fetch(base + '/deliveries/cabinet-a')).arrayBuffer());
  assert.equal(body.readUInt32LE(12 * 512 + 3 * 128 + 116), 0);
});
