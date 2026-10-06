// Stand-in for an OpenAI-compatible relay (中转站): /v1/images/generations, /v1/images/edits, /v1/chat/completions, /v1/models.
// FAKE_RELAY_MODE: (unset) b64 PNG · url (image served by URL) · alpha (RGBA with transparency) · noimage · tall (2×3 PNG) · fail500
import { createServer } from 'node:http';
import { encodePng } from '../scripts/lib/png.mjs';

const PNG = encodePng(2, 1, Buffer.from([255, 0, 0, 0, 0, 255]), 3);
const PNG_ALPHA = encodePng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]), 4);
const PNG_TALL = encodePng(2, 3, Buffer.alloc(2 * 3 * 3, 200), 3);

export async function startFakeRelay({ key = 'sk-test-0123456789' } = {}) {
  const requests = []; let failures = 0;
  const server = createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks); const mode = process.env.FAKE_RELAY_MODE || '';
      const entry = { method: req.method, path: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || '', body: body.toString('utf8') };
      try { entry.json = JSON.parse(entry.body); } catch { /* multipart */ }
      requests.push(entry);
      const send = (status, obj, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
      const png = mode === 'alpha' ? PNG_ALPHA : mode === 'tall' ? PNG_TALL : PNG;
      if (req.url === '/files/out.png') return send(200, png, 'image/png');
      if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: `invalid api key ${req.headers.authorization}` } });
      if (mode === 'fail500' && failures++ < 1) return send(502, { error: { message: 'upstream busy' } });
      if (req.url === '/v1/models') return send(200, { data: [{ id: 'gpt-image-1' }, { id: 'gemini-2.5-flash-image' }, { id: 'gpt-4o-mini' }] });
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
        if (mode === 'noimage') return send(200, { data: [] });
        const item = mode === 'url' ? { url: `${origin}/files/out.png` } : { b64_json: png.toString('base64') };
        return send(200, { created: 1, data: [{ ...item, revised_prompt: 'REVISED' }] });
      }
      if (req.url === '/v1/chat/completions') {
        if (mode === 'noimage') return send(200, { choices: [{ message: { role: 'assistant', content: 'I cannot draw that.' } }] });
        const content = mode === 'url' ? `Here you go ![image](${origin}/files/out.png)` : `![image](data:image/png;base64,${png.toString('base64')})`;
        return send(200, { choices: [{ message: { role: 'assistant', content } }] });
      }
      send(404, { error: { message: `no route ${req.url}` } });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, key, requests, close: () => new Promise(r => server.close(r)) };
}
