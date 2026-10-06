// Core: run image generations through an OpenAI-compatible relay (中转站) instead of the Codex CLI.
// Two wire formats, because relays expose image models in two ways:
//   images  POST {base}/images/generations (JSON)  and  POST {base}/images/edits (multipart, for reference images)
//           gpt-image-*, dall-e-3, flux, seedream, imagen … — anything served on the Images API.
//   chat    POST {base}/chat/completions with the prompt (and reference images as data URLs); the image comes back
//           in the message (markdown link, data URL, `images[]`, or image parts). gemini-*-image, nano-banana, gpt-4o-image …
// Zero dependencies: Node 18+ global fetch / FormData / Blob.
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { cropToRatio, flattenAlpha } from './png.mjs';

export const CLIENT = { name: 'forestq-codex-imagegen', version: '1.0.0' };
export const DEFAULT_TIMEOUT_S = 300;
export const DEFAULT_MODEL = 'gpt-image-1';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
export const mimeOf = path => MIME[extname(path).toLowerCase()] || 'image/png';
const exists = p => access(p).then(() => true, () => false);

export const defaultOutDir = () => join(homedir(), 'Pictures', 'forestq-codex-imagegen', new Date().toISOString().slice(0, 10));
export const expandHome = p => String(p).replace(/^~(?=\/|$)/, homedir());

// ---------------------------------------------------------------- configuration
// Priority: per-call arguments > environment > config file > defaults.
export const configPath = () => expandHome(process.env.FORESTQ_IMAGEGEN_CONFIG || join(homedir(), '.config', 'forestq-codex-imagegen', 'config.json'));
function readConfigFile() {
  try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[forestq-codex-imagegen] cannot read ${configPath()}: ${e.message}`);
    return {};
  }
}
const ENV = {
  base_url: ['FORESTQ_IMAGEGEN_BASE_URL', 'OPENAI_BASE_URL'],
  api_key: ['FORESTQ_IMAGEGEN_API_KEY', 'OPENAI_API_KEY'],
  model: ['FORESTQ_IMAGEGEN_MODEL'],
  mode: ['FORESTQ_IMAGEGEN_MODE'],
  size_strategy: ['FORESTQ_IMAGEGEN_SIZE_STRATEGY'],
  exact_pixels: ['FORESTQ_IMAGEGEN_EXACT_PIXELS'],
  quality: ['FORESTQ_IMAGEGEN_QUALITY'],
  extra_body: ['FORESTQ_IMAGEGEN_EXTRA_BODY'],
  edit_field: ['FORESTQ_IMAGEGEN_EDIT_FIELD'],
  retries: ['FORESTQ_IMAGEGEN_RETRIES'],
  timeout_seconds: ['FORESTQ_IMAGEGEN_TIMEOUT'],
};
export const CONFIG_KEYS = Object.keys(ENV);

export function normalizeBaseUrl(raw) {
  let url = String(raw || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  url = url.replace(/\/(chat\/completions|images\/(generations|edits)|models)$/i, ''); // pasted a full endpoint
  try { const u = new URL(url); if (u.pathname === '/' || u.pathname === '') url = `${u.origin}/v1`; } catch { throw new Error(`invalid base_url "${raw}"`); }
  return url;
}

// Models that relays only serve through chat/completions.
const CHAT_MODEL = /gemini|banana|4o-image|gpt-4o-all|sora[-_]?image|-all$/i;
export const autoMode = model => (CHAT_MODEL.test(model) ? 'chat' : 'images');

export function resolveConfig(overrides = {}) {
  const file = readConfigFile();
  const pick = key => {
    if (overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '') return overrides[key];
    for (const name of ENV[key]) if (process.env[name]) return process.env[name];
    return file[key];
  };
  const cfg = Object.fromEntries(CONFIG_KEYS.map(k => [k, pick(k)]));
  cfg.base_url = normalizeBaseUrl(cfg.base_url);
  cfg.model = String(cfg.model || DEFAULT_MODEL);
  cfg.mode = !cfg.mode || cfg.mode === 'auto' ? autoMode(cfg.model) : String(cfg.mode);
  if (!['images', 'chat'].includes(cfg.mode)) throw new Error(`mode must be images, chat or auto (got "${cfg.mode}")`);
  if (typeof cfg.extra_body === 'string') { try { cfg.extra_body = JSON.parse(cfg.extra_body); } catch { throw new Error('extra_body / FORESTQ_IMAGEGEN_EXTRA_BODY must be a JSON object'); } }
  cfg.extra_body = cfg.extra_body && typeof cfg.extra_body === 'object' ? cfg.extra_body : {};
  cfg.retries = Math.min(5, Math.max(0, Number.isFinite(Number(cfg.retries)) && cfg.retries !== undefined ? Number(cfg.retries) : 2));
  cfg.exact_pixels = Number(cfg.exact_pixels) || 1024 * 1536;
  return cfg;
}

export const maskKey = key => (!key ? '(not set)' : key.length <= 10 ? '***' : `${key.slice(0, 5)}…${key.slice(-4)}`);
export function describeConfig(cfg) {
  return [`base_url: ${cfg.base_url}`, `api_key: ${maskKey(cfg.api_key)}`, `model: ${cfg.model}`, `mode: ${cfg.mode}`,
    `size_strategy: ${cfg.size_strategy || `(default: ${defaultStrategy(cfg.model)})`}`, ...(cfg.quality ? [`quality: ${cfg.quality}`] : []),
    ...(Object.keys(cfg.extra_body).length ? [`extra_body: ${JSON.stringify(cfg.extra_body)}`] : []), `config file: ${configPath()}`].join('\n');
}

// ---------------------------------------------------------------- size
export const parseRatio = r => { const m = String(r || '').match(/^(\d+(?:\.\d+)?)\s*[:x/：]\s*(\d+(?:\.\d+)?)$/i); return m ? Number(m[1]) / Number(m[2]) : undefined; };
const defaultStrategy = model => (/gpt-image|dall-e/i.test(model) ? 'standard' : 'none');

// size: explicit "WxH" | "auto" | "none". Otherwise from the strategy:
//   standard  nearest size the OpenAI models accept (gpt-image: 1024², 1536×1024, 1024×1536; dall-e-3: 1792 variants)
//   exact     the requested ratio at ~exact_pixels, multiples of 16 (flux, seedream, gpt-image-2 style flexible sizes)
//   auto      send "auto";  none  send no size (the ratio is still written into the prompt)
export function pickSize({ ratio, model, strategy, size, exactPixels = 1024 * 1536 }) {
  if (size) return size === 'none' ? undefined : String(size).replace('×', 'x');
  const mode = strategy || defaultStrategy(model); const want = parseRatio(ratio);
  if (mode === 'none') return undefined;
  if (mode === 'auto') return 'auto';
  if (mode === 'exact') {
    if (!want) return undefined;
    const w = Math.round(Math.sqrt(exactPixels * want) / 16) * 16, h = Math.round(Math.sqrt(exactPixels / want) / 16) * 16;
    return `${w}x${h}`;
  }
  if (mode !== 'standard') throw new Error(`size_strategy must be standard, exact, auto or none (got "${mode}")`);
  const options = /dall-e-3/i.test(model) ? ['1024x1024', '1792x1024', '1024x1792'] : /dall-e-2/i.test(model) ? ['1024x1024'] : ['1024x1024', '1536x1024', '1024x1536'];
  if (!want) return undefined;
  const score = s => { const [w, h] = s.split('x').map(Number); return Math.abs(Math.log(w / h) - Math.log(want)); };
  return options.reduce((a, b) => (score(b) < score(a) ? b : a));
}

// ---------------------------------------------------------------- HTTP
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
function redact(text, cfg) { let t = String(text); if (cfg.api_key) t = t.split(cfg.api_key).join(maskKey(cfg.api_key)); return t; }

async function call(cfg, path, { json, form, method = 'POST', timeoutMs, progress }) {
  if (!cfg.api_key) throw new Error(`no API key. Set FORESTQ_IMAGEGEN_API_KEY (and FORESTQ_IMAGEGEN_BASE_URL for your relay), or write ${configPath()} — see README.`);
  const url = cfg.base_url + path; let lastError;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (attempt) { progress?.(`retry ${attempt}/${cfg.retries}: ${lastError.message.slice(0, 120)}`); await sleep(Math.min(20000, 2000 * 2 ** (attempt - 1))); }
    let res;
    try {
      res = await fetch(url, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': `${CLIENT.name}/${CLIENT.version}` },
        body: json ? JSON.stringify(json) : form,
      });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`${path} timed out after ${Math.round(timeoutMs / 1000)}s (raise timeout_seconds; image models often need 60–180 s)`);
      lastError = new Error(`cannot reach ${cfg.base_url}: ${e?.cause?.code || e?.cause?.message || e?.message}`); continue;
    }
    const body = await res.text();
    if (res.ok) {
      try { return JSON.parse(body); } catch { throw new Error(`${path}: relay returned non-JSON (${res.status}): ${redact(body.slice(0, 300), cfg)}`); }
    }
    let message = body.slice(0, 600);
    try { const j = JSON.parse(body); message = j.error?.message || j.message || j.detail || j.msg || message; if (typeof message !== 'string') message = JSON.stringify(message); } catch { /* raw text */ }
    lastError = new Error(`${path} → HTTP ${res.status}: ${redact(message, cfg)}${hintFor(res.status, path)}`);
    if (!RETRY_STATUS.has(res.status)) throw lastError;
  }
  throw lastError;
}
function hintFor(status, path) {
  if (status === 401 || status === 403) return ' (check the API key / that this key may use the model)';
  if (status === 404) return path.startsWith('/images') ? ' (this relay may not serve the Images API for this model; try mode "chat", or check base_url ends with /v1)' : ' (check base_url ends with /v1 and the model name)';
  if (status === 429) return ' (rate limit or out of balance on the relay)';
  return '';
}

// ---------------------------------------------------------------- decode responses
function sniff(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  return undefined;
}
async function download(url, cfg, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`could not download the generated image (HTTP ${res.status}): ${url.slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}
// Turn one image reference (data URL, http URL or bare base64) into { buffer, ext }.
async function materialize(source, cfg, timeoutMs) {
  const s = String(source).trim();
  const data = s.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
  let buffer;
  if (data) buffer = Buffer.from(data[2], 'base64');
  else if (/^https?:\/\//i.test(s)) buffer = await download(s, cfg, timeoutMs);
  else buffer = Buffer.from(s, 'base64');
  const ext = sniff(buffer);
  if (!ext) throw new Error('the relay returned something that is not a PNG/JPEG/WebP/GIF image');
  return { buffer, ext };
}

// Pull image references out of a chat completion message, whatever shape the relay uses.
export function imagesFromChatMessage(message = {}) {
  const found = [];
  const add = v => { if (typeof v === 'string' && v && !found.includes(v)) found.push(v); };
  for (const img of message.images || []) add(img?.image_url?.url || img?.url || img?.b64_json);
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    add(p.image_url?.url || (typeof p.image_url === 'string' ? p.image_url : undefined));
    if (p.type === 'output_image' || p.type === 'image') add(p.b64_json || p.image_base64 || p.data || p.url);
    const inline = p.inline_data || p.inlineData; if (inline?.data) add(`data:${inline.mime_type || inline.mimeType || 'image/png'};base64,${inline.data}`);
  }
  const text = [typeof message.content === 'string' ? message.content : '', ...parts.filter(p => typeof p?.text === 'string').map(p => p.text)].join('\n');
  for (const m of text.matchAll(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)) add(m[0]);
  for (const m of text.matchAll(/!\[[^\]]*\]\((\S+?)\)/g)) add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"'<>]*)?/gi)) add(m[0]);
  return { sources: found, text: text.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image]').trim() };
}

// ---------------------------------------------------------------- the two routes
async function viaImages(cfg, { prompt, referenceImages, size, transparent, timeoutMs, progress }) {
  const params = { model: cfg.model, prompt, n: 1, ...(size ? { size } : {}), ...(cfg.quality ? { quality: cfg.quality } : {}) };
  if (/dall-e/i.test(cfg.model)) params.response_format = 'b64_json';
  if (transparent && /gpt-image/i.test(cfg.model)) { params.background = 'transparent'; params.output_format = 'png'; }
  Object.assign(params, cfg.extra_body);
  let res;
  if (!referenceImages.length) { progress?.(`${cfg.model} → images/generations${size ? ` (${size})` : ''}…`); res = await call(cfg, '/images/generations', { json: params, timeoutMs, progress }); }
  else {
    progress?.(`${cfg.model} → images/edits with ${referenceImages.length} reference(s)…`);
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const field = cfg.edit_field || (referenceImages.length > 1 ? 'image[]' : 'image');
    for (const ref of referenceImages) form.append(field, new Blob([await readFile(ref)], { type: mimeOf(ref) }), basename(ref));
    res = await call(cfg, '/images/edits', { form, timeoutMs, progress });
  }
  const items = Array.isArray(res?.data) ? res.data : [];
  const out = [];
  for (const item of items) { const src = item.b64_json || item.url; if (src) out.push({ ...(await materialize(src, cfg, timeoutMs)), revisedPrompt: item.revised_prompt }); }
  if (!out.length) throw new Error(`images API returned no image${res?.error ? ': ' + JSON.stringify(res.error) : ''}`);
  return out;
}

async function viaChat(cfg, { prompt, referenceImages, timeoutMs, progress }) {
  const intro = referenceImages.length ? 'The attached image(s) are references: use them as the style reference or as the image to edit, as the prompt says.\n\n' : '';
  const text = `${intro}Generate one image (output the image itself, not a description):\n${prompt}`;
  const content = referenceImages.length
    ? [{ type: 'text', text }, ...(await Promise.all(referenceImages.map(async r => ({ type: 'image_url', image_url: { url: `data:${mimeOf(r)};base64,${(await readFile(r)).toString('base64')}` } }))))]
    : text;
  progress?.(`${cfg.model} → chat/completions…`);
  const res = await call(cfg, '/chat/completions', { json: { model: cfg.model, messages: [{ role: 'user', content }], stream: false, ...cfg.extra_body }, timeoutMs, progress });
  const message = res?.choices?.[0]?.message || {};
  const { sources, text: reply } = imagesFromChatMessage(message);
  if (!sources.length) throw new Error(`${cfg.model} answered without an image${reply ? `: "${reply.slice(0, 300)}"` : ''} (is this an image model? try another model or mode "images")`);
  const out = [];
  for (const src of sources) { progress?.('downloading image…'); out.push(await materialize(src, cfg, timeoutMs)); }
  return out;
}

// One generation. Returns [{ path, size, revisedPrompt }]. `prompt` is final text (see prompt.mjs for building it).
export async function generateOne({ prompt, referenceImages = [], outDir, baseName, cfg, size, transparent, timeoutSeconds, progress }) {
  const timeoutMs = Math.max(30, Number(timeoutSeconds) || Number(cfg.timeout_seconds) || DEFAULT_TIMEOUT_S) * 1000;
  const run = cfg.mode === 'chat' ? viaChat : viaImages;
  const results = await run(cfg, { prompt, referenceImages, size, transparent, timeoutMs, progress });
  const saved = [];
  for (const [index, r] of results.entries()) {
    const target = join(outDir, `${baseName}${results.length > 1 ? `-${index + 1}` : ''}${r.ext}`);
    await writeFile(target, r.buffer);
    saved.push({ path: target, size: (await stat(target)).size, revisedPrompt: r.revisedPrompt || undefined });
  }
  return saved;
}

// Dimensions straight from the file header (PNG / JPEG / WebP), so callers can confirm the ratio without extra tools.
export async function imageSize(path) {
  const b = await readFile(path);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) { let o = 2; while (o + 9 < b.length) { if (b[o] !== 0xff) { o++; continue; } const m = b[o + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: b.readUInt16BE(o + 5), width: b.readUInt16BE(o + 7) }; o += 2 + b.readUInt16BE(o + 2); } }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const k = b.toString('ascii', 12, 16);
    if (k === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (k === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (k === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  return undefined;
}

// Full request: resolves config and paths, runs `count` generations in parallel, reports sizes and whether the ratio was honoured.
export async function generate(options) {
  const { finalPrompt, referenceImages = [], outDir: rawOut, fileName, count = 1, aspectRatio } = options;
  if (!String(finalPrompt || '').trim()) throw new Error('prompt is required');
  const cfg = resolveConfig({ model: options.model, mode: options.mode, quality: options.quality, size_strategy: options.sizeStrategy });
  for (const ref of referenceImages) if (!ref.startsWith('/') || !(await exists(ref))) throw new Error(`reference image not found (use an absolute path): ${ref}`);
  const size = pickSize({ ratio: aspectRatio, model: cfg.model, strategy: cfg.size_strategy, size: options.size, exactPixels: cfg.exact_pixels });
  const outDir = resolve(expandHome(rawOut || defaultOutDir()));
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseName = String(fileName || `image-${stamp}`).replace(/[^\w.\-一-龥]+/g, '_').replace(/\.(png|jpe?g|webp|gif)$/i, '');
  const n = Math.min(4, Math.max(1, Math.floor(Number(count)) || 1));
  const runs = await Promise.allSettled(Array.from({ length: n }, (_, i) => generateOne({
    prompt: finalPrompt, referenceImages, outDir, baseName: n > 1 ? `${baseName}-v${i + 1}` : baseName, cfg, size, transparent: options.transparentBackground === true,
    timeoutSeconds: options.timeoutSeconds, progress: options.progress && (m => options.progress(n > 1 ? `v${i + 1}: ${m}` : m)),
  })));
  const images = runs.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  if (!images.length) throw (runs[0].reason instanceof Error ? runs[0].reason : new Error(String(runs[0].reason)));
  const want = parseRatio(aspectRatio);
  for (const image of images) {
    image.dimensions = await imageSize(image.path).catch(() => undefined);
    if (want && image.dimensions) {
      const got = image.dimensions.width / image.dimensions.height; image.ratioOk = Math.abs(got - want) / want < 0.06;
      // Fixed-size models (gpt-image: 2:3 / 3:2 / 1:1) cannot hit 3:4, 16:9, 9:16 … exactly: optionally centre-crop.
      if (!image.ratioOk && options.cropToRatio) {
        const c = await cropToRatio(image.path, want).catch(() => ({ cropped: false }));
        if (c.cropped) { image.cropped = { from: image.dimensions, to: { width: c.width, height: c.height } }; image.dimensions = { width: c.width, height: c.height }; image.ratioOk = true; }
      }
    }
  }
  // A poster must be opaque: models sometimes return transparent regions, which viewers show as black or checkerboard.
  if (options.transparentBackground !== true) for (const image of images) { const r = await flattenAlpha(image.path, { background: options.background || '#ffffff' }).catch(() => ({ flattened: false })); if (r.flattened) { image.flattened = true; image.transparent = r.transparent; } }
  for (const image of images) image.size = (await stat(image.path)).size;
  const failures = runs.filter(r => r.status === 'rejected').map(r => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  return { images, failures, outDir, backend: { model: cfg.model, mode: cfg.mode, base_url: cfg.base_url, size } };
}

// Free connectivity check: GET /models. Reports whether the key works and the configured model is listed.
export async function checkBackend(overrides = {}) {
  const cfg = resolveConfig(overrides);
  const lines = [describeConfig(cfg), ''];
  if (!cfg.api_key) return { ok: false, text: lines.concat('✗ no API key configured').join('\n') };
  try {
    const res = await call({ ...cfg, retries: 0 }, '/models', { method: 'GET', timeoutMs: 20000 });
    const ids = (res?.data || []).map(m => m.id).filter(Boolean);
    const image = ids.filter(id => /image|dall-e|flux|seedream|imagen|banana|kontext|midjourney|recraft|ideogram|sd3|stable/i.test(id));
    lines.push(`✓ relay reachable, key accepted, ${ids.length} models listed`);
    lines.push(ids.includes(cfg.model) ? `✓ model "${cfg.model}" is listed` : `? model "${cfg.model}" is not in /models (some relays hide models; a real generation will tell)`);
    if (image.length) lines.push(`image-capable models seen: ${image.slice(0, 30).join(', ')}`);
    return { ok: true, text: lines.join('\n'), models: ids };
  } catch (e) { return { ok: false, text: lines.concat(`✗ ${e.message}`).join('\n') }; }
}
