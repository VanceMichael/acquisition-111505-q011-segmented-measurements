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
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, project.probeBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) } : {}); const raw = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: raw.length, 来源类型: observed.headers.get('content-type') }));
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
  const receipt = await collected.json();
  console.log(JSON.stringify({
    自动领取状态: collected.status,
    收件编号: receipt.receipt,
    原件摘要: receipt.envelope?.sha256,
    目录对象: receipt.objects?.map(object => ({ 路径: object.path, 类型: object.kind, 状态: object.status, 来源分配: object.source?.kind, 字节: object.size })),
    问题: receipt.issues?.map(issue => issue.code),
  }));
  const first = receipt.objects?.find(object => object.path === '/ObjectPool/Summary');
  if (first) {
    const content = await fetch(`${base}/api/records/${receipt.receipt}/objects/${first.entryIndex}`);
    console.log(JSON.stringify({ 内嵌流: first.path, 内容: Buffer.from(await content.arrayBuffer()).toString() }));
    const sourceBytes = await fetch(`${base}/api/records/${receipt.receipt}/objects/${first.entryIndex}?format=source`);
    console.log(JSON.stringify({ 源字节: sourceBytes.status, 字节数: Buffer.from(await sourceBytes.arrayBuffer()).length }));
  }
  for (const mode of ['chain-cycle', 'directory-cycle', 'shared-sector']) {
    await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    const reply = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
    const body = await reply.json();
    console.log(JSON.stringify({
      情景: mode,
      状态: reply.status,
      确认流: body.objects?.filter(object => object.kind === 'stream' && object.status === 'confirmed').map(object => object.path),
      未确认流: body.objects?.filter(object => object.kind === 'stream' && object.status !== 'confirmed').map(object => ({ 路径: object.path, 目录项: object.entryIndex, 原因: object.issues })),
    }));
  }
  console.log(JSON.stringify({ 已存记录: (await (await fetch(base + '/api/records')).json()).map(record => ({ 来源: record.source, 身份: record.identity, 版本数: record.versions.length })) }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await new Promise(resolve => intake.close(resolve)); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true }); }
