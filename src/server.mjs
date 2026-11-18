import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { receiveDelivery, lookupVersion, lookupObject, readSourceBytes, readStreamContent } from './collect.mjs';

const LIMIT = 1048576;

function readJson(incoming) {
  return (async () => {
    const chunks = [];
    let length = 0;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > LIMIT) return { tooLarge: true };
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return { empty: true };
    try { return { value: JSON.parse(text) }; }
    catch { return { invalid: true, text: text.trim() }; }
  })();
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => {
      outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify(body));
    };
    const replyBytes = (status, type, body) => {
      outgoing.writeHead(status, { 'content-type': type, 'content-length': body.length });
      outgoing.end(body);
    };
    try {
      const url = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && url.pathname === '/health') {
        return reply(200, { status: 'ok', acquisition: ['manual', 'auto'] });
      }
      if (incoming.method === 'GET' && url.pathname === '/api/records') {
        return reply(200, await archive.list());
      }
      if (incoming.method === 'POST' && url.pathname === '/api/collect') {
        const payload = await readJson(incoming);
        if (payload.tooLarge) return reply(413, { error: '单份采集请求过大', code: 'request-too-large' });
        if (payload.empty) return reply(400, { error: '采集请求需要 source', code: 'missing-source' });
        if (payload.invalid) {
          // A bare body is the source address; anything else is malformed JSON.
          if (/^https?:\/\/\S+$/.test(payload.text)) payload.value = { source: payload.text };
          else return reply(400, { error: 'JSON 无效', code: 'invalid-json' });
        }
        if (typeof payload.value === 'string') payload.value = { source: payload.value };
        if (!payload.value || typeof payload.value !== 'object') {
          return reply(400, { error: '采集请求需要 source', code: 'missing-source' });
        }
        try { return reply(201, await receiveDelivery(archive, payload.value)); }
        catch (error) {
          if (error.name === 'CollectError') return reply(error.status, { error: error.message, code: error.code, details: error.details });
          throw error;
        }
      }
      const objectMatch = /^\/api\/records\/([0-9a-f]{64})\/objects\/(\d+)$/.exec(url.pathname);
      if (incoming.method === 'GET' && objectMatch) {
        const options = {
          entryIndex: Number(objectMatch[2]),
          version: url.searchParams.has('version') ? url.searchParams.get('version') : undefined,
        };
        try {
          if (url.searchParams.get('format') === 'source') {
            const { bytes, object } = await readSourceBytes(archive, objectMatch[1], options);
            return replyBytes(200, 'application/octet-stream', bytes, object);
          }
          const { bytes, object } = await readStreamContent(archive, objectMatch[1], options);
          return replyBytes(200, 'application/octet-stream', bytes, object);
        } catch (error) {
          if (error.name === 'CollectError') return reply(error.status, { error: error.message, code: error.code, details: error.details });
          throw error;
        }
      }
      const receiptMatch = /^\/api\/records\/([0-9a-f]{64})$/.exec(url.pathname);
      if (incoming.method === 'GET' && receiptMatch) {
        const selector = {
          version: url.searchParams.has('version') ? url.searchParams.get('version') : undefined,
          entryIndex: url.searchParams.has('entryIndex') ? url.searchParams.get('entryIndex') : undefined,
          path: url.searchParams.has('path') ? url.searchParams.get('path') : undefined,
        };
        try {
          const { record, version } = await lookupVersion(archive, receiptMatch[1], selector);
          const summary = {
            receipt: receiptMatch[1],
            source: record.source,
            identity: record.identity,
            version: version.version,
            receivedAt: version.receivedAt,
            data: version.data,
          };
          // A human receipt has no directory objects; its detail stays valid
          // but the object selector is refused with the normal 409.
          if (record.source !== 'auto' && (selector.entryIndex !== undefined || selector.path !== undefined)) {
            return reply(409, { error: '该收件不是自动领取的复合交付件，没有目录对象', code: 'not-collected' });
          }
          if (selector.entryIndex !== undefined || selector.path !== undefined) {
            const found = await lookupObject(archive, receiptMatch[1], selector);
            return reply(200, { ...summary, object: found.object });
          }
          return reply(200, summary);
        } catch (error) {
          if (error.name === 'CollectError') return reply(error.status, { error: error.message, code: error.code, details: error.details });
          throw error;
        }
      }
      if (incoming.method === 'POST' && url.pathname === '/api/manual') {
        const payload = await readJson(incoming);
        if (payload.tooLarge) return reply(413, { error: '单份人工收件过大' });
        if (payload.invalid || payload.empty) return reply(400, { error: 'JSON 无效' });
        try { return reply(201, await receiveManual(archive, payload.value)); }
        catch (error) { return reply(422, { error: error.message }); }
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
