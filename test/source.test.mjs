import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('同一通道跨段改变布局、单位和标定', async context => {
  const { base } = await withSource(context); const layout = await (await fetch(base + '/measurements/layout')).json();
  assert.equal(layout.segments[0].channels[0].unit, 'N'); assert.equal(layout.segments[1].channels[0].unit, 'kN');
  const raw = Buffer.from(await (await fetch(base + '/measurements/raw')).arrayBuffer()); assert.equal(raw.readDoubleLE(0), 1.5); assert.equal(raw.readInt16LE(32), 10); assert.equal(raw.readInt16LE(34), 100);
});
test('继承段和未封口尾部由来源明确标记', async context => {
  const { base, control } = await withSource(context); await control({ inherit: true });
  let layout = await (await fetch(base + '/measurements/layout')).json(); assert.equal(layout.segments[2].metadataMode, 'inherit'); assert.equal(layout.segments[2].channels, undefined);
  await control({ unsealed: true, inherit: false }); layout = await (await fetch(base + '/measurements/layout')).json(); assert.equal(layout.segments.at(-1).nextOffset, -1);
});
