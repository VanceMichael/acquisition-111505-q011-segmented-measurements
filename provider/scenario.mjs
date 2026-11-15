export const initialState = () => ({ name: '台架分段测量', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/measurements') { json(200, [{ delivery: 'endurance-1', layout: '/measurements/layout', data: '/measurements/raw' }]); return true; }
  if (url.pathname === '/measurements/layout') {
    const layout = JSON.parse(await readFile(new URL('../fixtures/layout.json', import.meta.url), 'utf8'));
    if (state.unsealed) layout.segments.at(-1).nextOffset = -1;
    if (state.inherit) layout.segments.push({ index: 2, nextOffset: 48, rawOffset: 40, byteLength: 8, layout: 'interleaved', metadataMode: 'inherit' });
    json(200, layout); return true;
  }
  if (url.pathname === '/measurements/raw') {
    let raw = await readFile(new URL('../fixtures/measurement.bin', import.meta.url)); if (state.inherit) raw = Buffer.concat([raw, raw.subarray(32)]); if (state.unsealed) raw = raw.subarray(0, raw.length - 2); bytes(200, raw); return true;
  }
  return false;
}
