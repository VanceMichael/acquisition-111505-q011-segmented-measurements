import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const initialState = () => ({ name: '旧式复合资料交付', revision: 1, mode: 'valid' });
const modes = new Set(['valid', 'chain-cycle', 'directory-cycle', 'shared-sector']);

export async function handle({ incoming, url, state, json, bytes }) {
  const mode = modes.has(state.mode) ? state.mode : 'valid';
  const data = await readFile(new URL(`../fixtures/${mode}.cfb`, import.meta.url));
  const sha256 = createHash('sha256').update(data).digest('hex');
  const etag = `"${state.revision}-${sha256}"`;
  if (url.pathname === '/deliveries') {
    json(200, { deliveries: [{ id: 'cabinet-a', version: state.revision, href: '/deliveries/cabinet-a', size: data.length, sha256, etag }] });
    return true;
  }
  if (url.pathname !== '/deliveries/cabinet-a') return false;
  if (incoming.headers['if-match'] && incoming.headers['if-match'] !== etag) {
    json(412, { error: '交付件已更换' });
    return true;
  }
  const headers = { etag, 'accept-ranges': 'bytes' };
  const range = incoming.headers.range;
  if (!range) {
    bytes(200, data, 'application/x-cfb', headers);
    return true;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  const start = match ? Number(match[1]) : -1;
  const end = match ? Number(match[2]) : -1;
  if (start < 0 || end < start || end >= data.length) {
    bytes(416, Buffer.alloc(0), 'application/x-cfb', { ...headers, 'content-range': `bytes */${data.length}` });
    return true;
  }
  bytes(206, data.subarray(start, end + 1), 'application/x-cfb', { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}` });
  return true;
}
