import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ 人工收件: await (await post(`${base}/api/manual`, sample)).json() }));

  const collected = await (await post(`${base}/api/collect`, { source })).json();
  console.log(JSON.stringify({ 自动采集: collected.deliveries[0].outcomes.map(item => ({ 路径: item.objectPath, 状态: item.status, 版本: item.version })) }));
  const again = await (await post(`${base}/api/collect`, { source })).json();
  console.log(JSON.stringify({ 重复采集全部复用身份: again.deliveries[0].outcomes.every(item => item.duplicate) }));

  const workbook = collected.deliveries[0].outcomes.find(item => item.objectPath === '/ObjectPool/Workbook');
  const claimed = await (await post(`${base}/api/claim`, { receipt: workbook.receipt, version: workbook.version })).json();
  console.log(JSON.stringify({ 按目录位置领取: claimed }));

  await post(`${source}/__control`, { mode: 'chain-cycle', revision: 2 });
  const degraded = await (await post(`${base}/api/collect`, { source })).json();
  console.log(JSON.stringify({ 链循环采集: degraded.deliveries[0].outcomes.map(item => ({ 路径: item.objectPath, 状态: item.status })) }));
  const stale = await post(`${base}/api/claim`, { receipt: workbook.receipt, version: workbook.version });
  console.log(JSON.stringify({ 旧位置领取新交付: { 状态: stale.status, 说明: await stale.json() } }));

  const records = await (await fetch(`${base}/api/records`)).json();
  console.log(JSON.stringify({ 已存记录: records.map(record => ({ 来源: record.source, 身份: record.identity, 版本数: record.versions.length })) }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
