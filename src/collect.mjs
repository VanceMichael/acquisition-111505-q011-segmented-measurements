import { digest } from './archive.mjs';
import { parseCompound } from './compound.mjs';
import { request, decodeJson } from './transport.mjs';

const MAX_ENVELOPE = 64 * 1024 * 1024;
export const AUTO_SOURCE = 'auto';

export class CollectError extends Error {
  constructor(code, message, status = 422, details = {}) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireUrl(value) {
  if (typeof value !== 'string' || value === '') throw new CollectError('missing-source', '缺少来源地址', 400);
  let url;
  try { url = new URL(value); } catch { throw new CollectError('invalid-source', '来源地址无效', 400); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CollectError('invalid-source', '来源协议不受支持', 400);
  return url;
}

// A listed href is data, not a trusted destination: it may only resolve inside
// the origin that produced the listing.
function deliveryUrl(source, href) {
  if (typeof href !== 'string' || href === '') throw new CollectError('invalid-delivery', '交付件缺少 href', 502);
  const url = new URL(href, source);
  if (url.origin !== source.origin) throw new CollectError('invalid-delivery', '交付件地址指向来源之外', 502, { href });
  return url.href;
}

async function call(url, headers = {}) {
  try {
    return await request(url, { headers });
  } catch (error) {
    throw new CollectError('source-unreachable', `无法连接来源：${error.message}`, 502);
  }
}

async function listDeliveries(source) {
  const reply = await call(new URL('/deliveries', source).href, { accept: 'application/json' });
  if (reply.status !== 200) throw new CollectError('listing-failed', `来源交付列表返回 ${reply.status}`, 502);
  let payload;
  try { payload = decodeJson(reply); }
  catch (error) { throw new CollectError('listing-invalid', error.message, 502); }
  if (!payload || !Array.isArray(payload.deliveries)) throw new CollectError('listing-invalid', '来源交付列表缺少 deliveries', 502);
  return payload.deliveries;
}

function selectDelivery(deliveries, wanted) {
  if (!deliveries.length) throw new CollectError('delivery-missing', '来源没有可领取的交付件', 404);
  if (wanted === undefined || wanted === null || wanted === '') {
    if (deliveries.length > 1) throw new CollectError('delivery-ambiguous', '来源有多个交付件，需要指定 delivery', 409);
    return deliveries[0];
  }
  const match = deliveries.find(item => item && item.id === wanted);
  if (!match) throw new CollectError('delivery-missing', `来源没有交付件 ${wanted}`, 404);
  return match;
}

function validateDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') throw new CollectError('invalid-delivery', '交付件条目无效', 502);
  if (typeof delivery.id !== 'string' || delivery.id === '') throw new CollectError('invalid-delivery', '交付件缺少 id', 502);
  if (typeof delivery.href !== 'string' || delivery.href === '') throw new CollectError('invalid-delivery', '交付件缺少 href', 502);
  if (typeof delivery.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(delivery.sha256)) {
    throw new CollectError('invalid-delivery', '交付件摘要格式无效', 502);
  }
  if (typeof delivery.etag !== 'string' || delivery.etag === '') throw new CollectError('invalid-delivery', '交付件缺少 ETag', 502);
  if (!Number.isSafeInteger(delivery.size) || delivery.size < 0) throw new CollectError('invalid-delivery', '交付件长度无效', 502);
  if (delivery.size > MAX_ENVELOPE) throw new CollectError('delivery-too-large', '交付件超出可领取大小', 413);
  return delivery;
}

// Every request is bound to the listed ETag. If the supplier replaced the
// file between listing and download, the source answers 412 and we refuse to
// apply the old directory placement to the new bytes.
async function downloadDelivery(source, delivery) {
  const reply = await call(deliveryUrl(source, delivery.href), { 'if-match': delivery.etag });
  if (reply.status === 412) throw new CollectError('delivery-changed', '交付件已更换，需要重新领取目录', 409, { etag: delivery.etag });
  if (reply.status !== 200) throw new CollectError('delivery-failed', `交付件正文返回 ${reply.status}`, 502);
  if (reply.bytes.length > MAX_ENVELOPE) throw new CollectError('delivery-too-large', '交付件超出可领取大小', 413);
  const actual = digest(reply.bytes);
  if (reply.bytes.length !== delivery.size || actual !== delivery.sha256) {
    throw new CollectError('delivery-mismatch', '交付件正文与来源清单不一致', 502, {
      size: { expected: delivery.size, actual: reply.bytes.length },
      sha256: { expected: delivery.sha256, actual },
    });
  }
  return reply.bytes;
}

// Object identity is scoped to one original file, not one supplier revision.
// Re-collecting the same original therefore lands on the same identities.
function objectKey(originDigest, path) {
  return digest(Buffer.from(JSON.stringify([originDigest, path])));
}

function manifestObject(object, originDigest) {
  const record = {
    objectKey: object.path ? objectKey(originDigest, object.path) : null,
    entryIndex: object.entryIndex,
    directoryEntry: object.directoryEntry,
    path: object.path,
    parentPath: object.parentPath ?? null,
    name: object.name,
    type: object.type,
    kind: object.kind,
    status: object.status,
    issues: object.issues,
    size: object.kind === 'stream' ? object.size : null,
    contentSha256: object.kind === 'stream' ? object.contentSha256 ?? null : null,
    allocation: object.allocation ? {
      kind: object.allocation.kind,
      start: object.allocation.start,
      sectorSize: object.allocation.sectorSize,
      sectors: object.allocation.sectors,
      contentSectors: object.allocation.contentSectors,
      byteRanges: object.allocation.byteRanges,
      contentByteRanges: object.allocation.contentByteRanges,
    } : null,
  };
  return record;
}

// Collect one delivery: list, download with ETag binding, parse, then persist
// every confirmed stream alongside the envelope. Nothing is executed or
// interpreted, so macros and embedded objects are copied as opaque bytes.
export async function receiveDelivery(archive, request = {}) {
  const source = request.source ?? request.url ?? request.origin;
  const wanted = request.delivery ?? request.id;
  const { etag, sha256 } = request;
  const revision = request.revision ?? request.deliveryVersion;
  const origin = requireUrl(source);
  const listed = await listDeliveries(origin);
  const selected = validateDelivery(selectDelivery(listed, wanted));

  // A pinned placement from an earlier listing may not be applied to a file
  // the supplier has since replaced.
  const pinnedRevision = revision !== undefined && Number(revision) !== Number(selected.version);
  if ((etag !== undefined && etag !== selected.etag)
    || (sha256 !== undefined && sha256 !== selected.sha256)
    || pinnedRevision) {
    throw new CollectError('delivery-changed', '交付件已更换，旧目录位置不能用于新文件', 409, {
      listed: { etag: selected.etag, sha256: selected.sha256, version: selected.version ?? null },
      pinned: { etag: etag ?? null, sha256: sha256 ?? null, version: revision ?? null },
    });
  }

  const bytes = await downloadDelivery(origin, selected);

  let parsed;
  try { parsed = parseCompound(bytes); }
  catch (error) {
    throw new CollectError(error.code || 'invalid-compound', `复合文件无法解析：${error.message}`, 422, error.details || {});
  }

  const envelope = await archive.store(bytes);
  const originScope = digest(Buffer.from(JSON.stringify([origin.origin, selected.id, envelope.sha256])));
  for (const object of parsed.objects) {
    if (object.kind === 'stream' && object.status === 'confirmed' && object.content) await archive.store(object.content);
  }

  const data = {
    delivery: { id: selected.id, version: selected.version ?? null, etag: selected.etag, size: selected.size },
    envelope: { sha256: envelope.sha256, size: envelope.size },
    format: parsed.format,
    directory: parsed.directory,
    stats: parsed.stats,
    objects: parsed.objects.map(object => manifestObject(object, originScope)),
    issues: parsed.issues,
  };
  // Business identity is the supplier origin plus the delivery number, matching
  // the archive's version model: a replacement file becomes a new version of
  // the same receipt, while the same source can never be mistaken for another.
  const identity = { origin: origin.origin, delivery: selected.id };
  // Revision counters and ETags are observations, not content: identical
  // original bytes stay one version even if the supplier republished them.
  const receipt = await archive.accept(AUTO_SOURCE, identity, data, bytes, { fingerprint: envelope.sha256 });
  return {
    ...receipt,
    source: AUTO_SOURCE,
    identity,
    delivery: data.delivery,
    envelope: data.envelope,
    stats: data.stats,
    objects: data.objects.map(object => ({
      objectKey: object.objectKey,
      entryIndex: object.entryIndex,
      directoryEntry: object.directoryEntry,
      path: object.path,
      parentPath: object.parentPath,
      name: object.name,
      type: object.type,
      kind: object.kind,
      status: object.status,
      issues: object.issues,
      size: object.size,
      contentSha256: object.contentSha256,
      source: object.allocation,
    })),
    issues: data.issues,
  };
}

// Look up one collected version, and optionally one directory object within
// it. `version` defaults to the newest; `entryIndex` addresses the directory
// entry and `path` the path recorded for that same version.
export async function lookupVersion(archive, receiptKey, { version } = {}) {
  let record;
  try { record = await archive.record(receiptKey); }
  catch (error) { if (error.code === 'ENOENT') throw new CollectError('unknown-receipt', '收件编号不存在', 404); throw error; }
  const index = version === undefined ? record.versions.length - 1 : record.versions.findIndex(item => item.version === Number(version));
  if (index < 0) throw new CollectError('unknown-version', '收件版本不存在', 404);
  return { record, version: record.versions[index] };
}

export async function lookupObject(archive, receiptKey, { version, entryIndex, path } = {}) {
  const found = await lookupVersion(archive, receiptKey, { version });
  const { record, version: chosen } = found;
  if (record.source !== AUTO_SOURCE || !Array.isArray(chosen.data?.objects)) {
    throw new CollectError('not-collected', '该收件不是自动领取的复合交付件，没有目录对象', 409);
  }
  let object;
  if (entryIndex !== undefined) object = chosen.data.objects.find(item => item.entryIndex === Number(entryIndex));
  else if (path !== undefined) object = chosen.data.objects.find(item => item.path === path);
  else throw new CollectError('missing-object', '需要 entryIndex 或 path 指定目录对象', 400);
  if (!object) throw new CollectError('unknown-object', '该版本没有这个目录对象', 404);
  return { record, version: chosen, object };
}

export async function readSourceBytes(archive, receiptKey, options = {}) {
  const { version, object } = await lookupObject(archive, receiptKey, options);
  if (object.kind !== 'stream') throw new CollectError('not-a-stream', '该目录项不是流对象，没有可领取的源字节', 409, { kind: object.kind });
  if (object.status !== 'confirmed' || !object.allocation) {
    throw new CollectError('unconfirmed-object', '该目录对象的内容未确认，不能提供源字节', 409, { issues: object.issues });
  }
  const envelope = await archive.bytes(version.data.envelope.sha256);
  // Return the sectors that hold the declared content, including sector
  // padding, but never surplus chain sectors that are not part of the stream.
  const ranges = object.allocation.contentByteRanges;
  const parts = ranges.map(range => envelope.subarray(range.offset, range.offset + range.length));
  return { version, object, bytes: Buffer.concat(parts).subarray(0, object.size), envelope };
}

export async function readStreamContent(archive, receiptKey, options = {}) {
  const { version, object } = await lookupObject(archive, receiptKey, options);
  if (object.kind !== 'stream') throw new CollectError('not-a-stream', '该目录项不是流对象，没有可领取的流内容', 409, { kind: object.kind });
  if (object.status !== 'confirmed' || !object.contentSha256) {
    throw new CollectError('unconfirmed-object', '该目录对象的内容未确认，不能提供流内容', 409, { issues: object.issues });
  }
  return { version, object, bytes: await archive.bytes(object.contentSha256) };
}
