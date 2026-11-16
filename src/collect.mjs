import { digest } from './archive.mjs';
import { parseCompoundFile } from './cfb.mjs';
import { request, decodeJson } from './transport.mjs';

export const normalizeSource = source => String(source).replace(/\/+$/, '');

const entrySnapshot = entry => ({
  id: entry.id, name: entry.name, type: entry.type,
  left: entry.left, right: entry.right, child: entry.child,
  start: entry.start, size: entry.size,
});

// 从来源领取交付件中的目录对象与原始流：先整件校验，再逐流独立确认。
// 单个流的损坏只影响自身，其余可独立确认的流照常归档。
export async function collectFromSource(archive, source) {
  const base = normalizeSource(source);
  const listing = decodeJson(await request(`${base}/deliveries`));
  const deliveries = [];
  for (const delivery of listing.deliveries ?? []) {
    deliveries.push(await collectDelivery(archive, base, delivery));
  }
  return { source: base, deliveries };
}

async function collectDelivery(archive, source, delivery) {
  const reply = await request(`${source}${delivery.href}`);
  if (reply.status !== 200) throw new Error(`交付 ${delivery.id} 下载失败：来源返回 ${reply.status}`);
  const bytes = reply.bytes;
  const sha256 = digest(bytes);
  if (bytes.length !== delivery.size || sha256 !== delivery.sha256) {
    throw new Error(`交付 ${delivery.id} 与来源目录登记的长度或摘要不符`);
  }
  const parsed = parseCompoundFile(bytes);
  if (!parsed.ok) throw new Error(`交付 ${delivery.id} 不是受支持的复合文件：${parsed.problems[0]?.detail ?? '未知原因'}`);
  const baseData = {
    delivery: delivery.id, deliveryVersion: delivery.version, href: delivery.href,
    etag: delivery.etag, deliverySha256: sha256, deliverySize: bytes.length,
  };
  const outcomes = [];
  const manifest = {
    ...baseData, objectPath: '/',
    entries: parsed.entries.map(entry => ({ ...entrySnapshot(entry), reachable: entry.reachable, path: entry.path })),
    problems: parsed.problems,
  };
  outcomes.push({ objectPath: '/', status: parsed.problems.length ? 'problems' : 'confirmed', ...(await archive.accept(source, { delivery: delivery.id, objectPath: '/' }, manifest, bytes)) });
  for (const stream of parsed.streams) {
    const data = {
      ...baseData, objectPath: stream.path,
      entry: entrySnapshot(parsed.entries[stream.entryId]),
      chain: stream.chain, sectors: stream.sectors, ranges: stream.ranges,
      size: stream.size, status: stream.status, problem: stream.problem,
      contentSha256: stream.sha256,
    };
    // 未确认的流只登记证据，原始字节为空，不按剩余字节猜出内容
    const raw = stream.content ?? Buffer.alloc(0);
    outcomes.push({ objectPath: stream.path, status: stream.status, ...(await archive.accept(source, { delivery: delivery.id, objectPath: stream.path }, data, raw)) });
  }
  return { id: delivery.id, version: delivery.version, etag: delivery.etag, sha256, outcomes };
}
