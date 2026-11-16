import { digest } from './archive.mjs';
import { request } from './transport.mjs';

export class ClaimError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 按收件版本登记的目录位置回源领取流字节。
// 位置与交付 ETag 绑定：供方更换文件后来源返回 412，旧位置不能用于领取新文件。
export async function claimVersion(archive, key, versionNumber) {
  const record = await archive.record(key);
  if (!record) throw new ClaimError(404, '收件不存在');
  const version = record.versions.find(item => item.version === versionNumber);
  if (!version) throw new ClaimError(404, '收件版本不存在');
  const data = version.data ?? {};
  if (!/^https?:\/\//.test(record.source)) throw new ClaimError(422, '该收件不来自可回源的来源');
  if (data.status !== 'confirmed') throw new ClaimError(422, '该版本内容未经确认，不能按目录位置领取');
  const parts = [];
  for (const range of data.ranges ?? []) {
    const reply = await request(`${record.source}${data.href}`, {
      headers: { 'if-match': data.etag, range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
    });
    if (reply.status === 412) throw new ClaimError(409, '交付件已更换，旧目录位置不能用于领取新文件');
    if (reply.status !== 206) throw new ClaimError(502, `来源范围请求返回 ${reply.status}`);
    parts.push(reply.bytes);
  }
  const content = Buffer.concat(parts).subarray(0, data.size ?? 0);
  const sha256 = digest(content);
  if (sha256 !== data.contentSha256) throw new ClaimError(409, '领取内容与收件登记的摘要不符');
  return { receipt: key, version: version.version, objectPath: record.identity?.objectPath ?? null, size: content.length, sha256, verified: true };
}
