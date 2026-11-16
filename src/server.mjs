import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectFromSource } from './collect.mjs';
import { claimVersion, ClaimError } from './claim.mjs';

const DEFAULT_SOURCE = process.env.SOURCE_URL || 'http://127.0.0.1:4200';

async function readBody(incoming, limit = 1048576) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') return reply(200, { status: 'ok', acquisition: 'manual+collect' });
      if (incoming.method === 'GET' && url.pathname === '/api/records') return reply(200, await archive.list());
      const recordMatch = /^\/api\/records\/([0-9a-f]{64})$/.exec(url.pathname);
      if (incoming.method === 'GET' && recordMatch) {
        const record = await archive.record(recordMatch[1]);
        return record ? reply(200, record) : reply(404, { error: '收件不存在' });
      }
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        const raw = await readBody(incoming);
        if (raw === null) return reply(413, { error: '采集请求过大' });
        let options = {};
        if (raw.length) { try { options = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); } }
        const source = typeof options.source === 'string' && options.source ? options.source : DEFAULT_SOURCE;
        try { return reply(200, await collectFromSource(archive, source)); }
        catch (error) { return reply(502, { error: `采集失败：${error.message}` }); }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/claim') {
        const raw = await readBody(incoming);
        if (raw === null) return reply(413, { error: '领取请求过大' });
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        if (!body || typeof body.receipt !== 'string' || !Number.isInteger(body.version)) return reply(422, { error: '需要 receipt 与整数 version' });
        try { return reply(200, await claimVersion(archive, body.receipt, body.version)); }
        catch (error) { return reply(error instanceof ClaimError ? error.status : 500, { error: error.message }); }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
        const raw = await readBody(incoming);
        if (raw === null) return reply(413, { error: '单份人工收件过大' });
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
