import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, catalog } from '../scripts/lib/prompt.mjs';
import { imageSize, parseRatio, pickSize, resolveConfig, normalizeBaseUrl, imagesFromChatMessage } from '../scripts/lib/api.mjs';
import { runTool, TOOLS } from '../scripts/lib/tools.mjs';
import { composePrompt, library } from '../scripts/lib/templates.mjs';
import { decodePng, encodePng, flattenAlpha } from '../scripts/lib/png.mjs';
import { suggestDirections } from '../scripts/lib/suggest.mjs';
import { getRecord, resetCorpusCache, searchCorpus } from '../scripts/lib/corpus.mjs';
import { startFakeRelay } from './fake-relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const relay = await startFakeRelay();
after(() => relay.close());
for (const k of Object.keys(process.env)) if (k.startsWith('FORESTQ_IMAGEGEN_') || k === 'OPENAI_API_KEY' || k === 'OPENAI_BASE_URL') delete process.env[k];
process.env.FORESTQ_IMAGEGEN_CONFIG = join(tmpdir(), 'forestq-no-such-config.json');
process.env.FORESTQ_IMAGEGEN_BASE_URL = relay.url;
process.env.FORESTQ_IMAGEGEN_API_KEY = relay.key;
process.env.FORESTQ_IMAGEGEN_SIZE_STRATEGY = 'none';
process.env.FORESTQ_IMAGEGEN_RETRIES = '1';
const last = () => relay.requests[relay.requests.length - 1];

test('catalog: every preset points at a real style, ratios parse', () => {
  const { presets, styles } = catalog();
  for (const [key, preset] of Object.entries(presets)) { assert.ok(styles[preset.style], `${key} → ${preset.style}`); assert.ok(parseRatio(preset.aspect_ratio), key); }
  assert.ok(Object.keys(styles).length >= 86);
});

test('buildPrompt: preset adds ratio and safe-area rules, default is text-free', () => {
  const built = buildPrompt({ prompt: '一杯咖啡', preset: 'xiaohongshu' });
  assert.match(built.prompt, /aspect ratio exactly 3:4 \(vertical/); assert.match(built.prompt, /1080×1440/); assert.match(built.prompt, /no text, letters/i);
});

test('buildPrompt: explicit text replaces the no-text rules, ratio override beats the preset', () => {
  const built = buildPrompt({ prompt: 'Dune', preset: 'video-cover', style: 'minimalist-lines', aspectRatio: '9:16', text: ['DUNE'] });
  assert.match(built.prompt, /exactly 9:16/); assert.match(built.prompt, /“DUNE”/); assert.doesNotMatch(built.prompt, /不要任何文字/); assert.doesNotMatch(built.prompt, /about 1920/);
});

test('buildPrompt: wide-only style suffix is dropped for a vertical ratio; unknown style is free text; unknown preset throws', () => {
  const wide = Object.entries(catalog().styles).find(([, s]) => /横向|宽屏|宽度是高度/.test(s.suffix || ''));
  assert.ok(!buildPrompt({ prompt: 'x', style: wide[0], aspectRatio: '3:4' }).prompt.includes(wide[1].suffix));
  assert.ok(buildPrompt({ prompt: 'x', style: 'my own look' }).warnings[0].includes('free-text'));
  assert.throws(() => buildPrompt({ prompt: 'x', preset: 'nope' }), /unknown preset/);
});

test('imageSize reads PNG headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-')); const p = join(dir, 'a.png');
  await writeFile(p, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  assert.deepEqual(await imageSize(p), { width: 2, height: 1 });
});

test('generate_image: saves under out_dir, reports size, ratio check, structured content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-'));
  const result = await runTool('generate_image', { prompt: 'a circle', aspect_ratio: '2:1', out_dir: dir, file_name: 'circle' });
  assert.equal(result.isError, undefined); assert.match(result.content[0].text, /circle\.png\s+2×1/); assert.match(result.structuredContent.prompt, /exactly 2:1/); assert.doesNotMatch(result.content[0].text, /ratio differs/);
  assert.deepEqual((await readdir(dir)).sort(), ['circle.json', 'circle.png']);
  const off = await runTool('generate_image', { prompt: 'a circle', aspect_ratio: '3:4', out_dir: dir, file_name: 'off' });
  assert.match(off.content[0].text, /ratio differs/);
});

test('generate_image: count runs variants in parallel with distinct names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-'));
  const result = await runTool('generate_image', { prompt: 'a circle', count: 3, out_dir: dir, file_name: 'v' });
  assert.deepEqual((await readdir(dir)).filter(f => f.endsWith('.png')).sort(), ['v-v1.png', 'v-v2.png', 'v-v3.png']); assert.equal(result.structuredContent.images.length, 3);
});

test('generate_image: reference images go to images/edits as multipart and must exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-')); const ref = join(dir, 'ref.png'); await writeFile(ref, 'x'); const ref2 = join(dir, 'ref2.png'); await writeFile(ref2, 'y');
  const ok = await runTool('generate_image', { prompt: 'edit it', reference_images: [ref], out_dir: dir, file_name: 'e' });
  assert.equal(ok.isError, undefined); assert.equal(last().path, '/v1/images/edits'); assert.match(last().type, /multipart\/form-data/); assert.match(last().body, /name="image"; filename="ref.png"/); assert.match(last().body, /name="model"\r\n\r\ngpt-image-1/);
  await runTool('generate_image', { prompt: 'merge', reference_images: [ref, ref2], out_dir: dir, file_name: 'e2' });
  assert.match(last().body, /name="image\[\]"; filename="ref2.png"/);
  const bad = await runTool('generate_image', { prompt: 'edit it', reference_images: ['/nope/x.png'], out_dir: dir });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /not found/);
});

test('generate_image: a response without an image becomes a readable error (images and chat)', async () => {
  process.env.FAKE_RELAY_MODE = 'noimage';
  try {
    const r = await runTool('generate_image', { prompt: 'x', out_dir: await mkdtemp(join(tmpdir(), 'qci-')) }); assert.equal(r.isError, true); assert.match(r.content[0].text, /returned no image/);
    const c = await runTool('generate_image', { prompt: 'x', model: 'gemini-2.5-flash-image', out_dir: await mkdtemp(join(tmpdir(), 'qci-')) }); assert.equal(c.isError, true); assert.match(c.content[0].text, /cannot draw/);
  } finally { delete process.env.FAKE_RELAY_MODE; }
});

test('MCP server speaks the protocol: initialize, tools/list, build_prompt call', async () => {
  const child = spawn('node', [join(here, '..', 'scripts', 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map(); let buf = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', c => { buf += c; const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls.filter(Boolean)) { const m = JSON.parse(l); replies.set(m.id, m); } });
  const ask = (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise(resolve => { const t = setInterval(() => { if (replies.has(id)) { clearInterval(t); resolve(replies.get(id)); } }, 10); }); };
  try {
    assert.equal((await ask(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'forestq-codex-imagegen');
    assert.deepEqual((await ask(2, 'tools/list', {})).result.tools.map(t => t.name), TOOLS.map(t => t.name));
    assert.match((await ask(3, 'tools/call', { name: 'build_prompt', arguments: { prompt: 'x', preset: 'poster' } })).result.content[0].text, /9:16/);
  } finally { child.kill(); }
});

test('CLI: --show-prompt and --list work offline', async () => {
  const run = args => new Promise(resolve => { const c = spawn('node', [join(here, '..', 'scripts', 'cli.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', d => { o += d; }); c.on('close', code => resolve({ code, o })); });
  const a = await run(['咖啡', '--preset', 'moments', '--show-prompt']); assert.equal(a.code, 0); assert.match(a.o, /4:5/);
  const b = await run(['--list']); assert.equal(b.code, 0); assert.match(b.o, /video-cover/);
});

const FILL = { topic: '社区阅读月', subject: '一名虚构成年读者', data: '仅三项：选摘录、写理解、建连接', headline: '慢读' };

test('templates: all 24 templates x 48 presets compose into clean prompts', () => {
  let presets = 0;
  for (const tpl of library().templates) for (const preset of tpl.presets) {
    presets++; const c = composePrompt({ template_id: tpl.id, preset_id: preset.id, variables: FILL });
    assert.equal(c.ok, true, `${preset.id} ${c.missing_required}`); assert.ok(c.prompt.length > 80, preset.id);
    assert.doesNotMatch(c.prompt, /[{}]/, `${preset.id} leaves a placeholder`); assert.doesNotMatch(c.prompt, /参考图无|依据无|undefined/, preset.id);
    assert.equal(c.settings.ratio, tpl.default_ratio); assert.ok(c.acceptance_checks.length >= 3);
  }
  assert.equal(presets, 48);
});

test('templates: missing identity / product / data inputs block instead of inventing', () => {
  const portrait = composePrompt({ template_id: 'T09', variables: { topic: '创作者' } });
  assert.equal(portrait.ok, false); assert.equal(portrait.prompt, ''); assert.match(portrait.missing_required.join(), /subject/);
  assert.match(composePrompt({ template_id: 'T20', variables: { topic: '峰会', subject: 'x' } }).missing_required.join(), /data/);
  assert.throws(() => composePrompt({ template_id: 'T99' }), /unknown template/); assert.throws(() => composePrompt({ template_id: 'T01', preset_id: 'T01-9' }), /unknown preset/);
});

test('templates: text modes and reference handling', () => {
  const none = composePrompt({ template_id: 'T12', variables: { topic: '可颂', subject: '原味可颂' } });
  assert.equal(none.text_mode, 'none'); assert.match(none.prompt, /完全无文字/); assert.doesNotMatch(none.prompt, /标题[“一]/);
  const exact = composePrompt({ template_id: 'T12', variables: { topic: '可颂', subject: '原味可颂', headline: '新鲜出炉', copy: ['限时 8 折'] } });
  assert.equal(exact.text_mode, 'exact_short'); assert.match(exact.prompt, /“新鲜出炉”/); assert.match(exact.prompt, /“限时 8 折”/); assert.match(exact.prompt, /仅出现提供的文字/);
  const later = composePrompt({ template_id: 'T01', variables: { topic: '赛事' } });
  assert.equal(later.text_mode, 'typeset_later'); assert.ok(later.typographic); assert.match(later.assumptions.join(), /依赖文字形体/);
  assert.match(composePrompt({ template_id: 'T09', variables: { topic: 'a', subject: 'b' } }).prompt, /不对应真实个人/);
  assert.match(composePrompt({ template_id: 'T09', variables: { topic: 'a', subject: 'b', reference: '附图 1（本人正脸）' } }).prompt, /参考图附图 1/);
  assert.equal(composePrompt({ template_id: 'T03-1', variables: { topic: '谷雨' } }).preset_id, 'T03-1');
});

test('templates: structural-override presets must be rewritten before generation', async () => {
  const c = composePrompt({ template_id: 'T09', preset_id: 'T09-2', variables: { topic: '创作者', subject: '一位虚构成年创作者' } });
  assert.equal(c.needs_rewrite, true); assert.match(c.structural_override, /深暗背景/);
  const blocked = await runTool('generate_image', { template_id: 'T09-2', variables: { topic: '创作者', subject: '虚构创作者' }, out_dir: await mkdtemp(join(tmpdir(), 'qci-')) });
  assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /raw_prompt/);
  const dir = await mkdtemp(join(tmpdir(), 'qci-'));
  const ok = await runTool('generate_image', { raw_prompt: '制作4:5的棚拍肖像。深暗背景……', template_id: 'T09-2', out_dir: dir, file_name: 'p' });
  assert.equal(ok.isError, undefined); assert.equal(JSON.parse(await readFile(join(dir, 'p.json'), 'utf8')).route, 'raw_prompt');
});

test('generate_image via a template writes a reproducible sidecar and lists acceptance checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-'));
  const r = await runTool('generate_image', { template_id: 'T03-1', variables: { topic: '谷雨与新芽', subject: '一枚嫩芽', action: '在通道下端展开', motif: '浅绿', primary: '浅绿', accent: '朱橙', background: '近白', lighting: '柔光' }, out_dir: dir, file_name: 't3' });
  assert.equal(r.isError, undefined); assert.match(r.content[0].text, /Check the image against/); assert.match(r.content[0].text, /中央狭长明亮通道/);
  const side = JSON.parse(await readFile(join(dir, 't3.json'), 'utf8'));
  assert.equal(side.template_id, 'T03'); assert.equal(side.preset_id, 'T03-1'); assert.match(side.prompt, /制作3:4的海报/); assert.match(side.prompt, /避免：/);
  assert.equal((await runTool('generate_image', { template_id: 'T09', variables: { topic: 'x' } })).isError, true);
});

test('suggest_directions: at least four, divergent families, Mondo option, exclude works', () => {
  const r = suggestDirections({ topic: '一个月的咖啡店阅读活动', deliverable: '视频封面' });
  assert.ok(r.directions.length >= 4); assert.ok(new Set(r.directions.map(d => d.family)).size >= 4);
  assert.ok(r.directions.some(d => d.kind === 'mondo')); assert.equal(new Set(r.directions.filter(d => d.kind === 'template').map(d => d.template_id)).size, r.directions.filter(d => d.kind === 'template').length);
  const more = suggestDirections({ topic: '一个月的咖啡店阅读活动', deliverable: '视频封面', exclude: r.directions.map(d => d.template_id).filter(Boolean) });
  assert.ok(more.directions.every(d => !r.directions.some(o => o.template_id && o.template_id === d.template_id)));
  assert.ok(suggestDirections({ topic: '小球员社区足球赛', deliverable: '海报' }).directions.slice(0, 2).some(d => d.template_id === 'T01'));
  assert.ok(suggestDirections({ topic: '新品蓝莓气泡水', deliverable: '电商首屏' }).directions.some(d => d.template_id === 'T13'));
  assert.equal(suggestDirections({ topic: '婚纱工作室主视觉', deliverable: '小红书' }).directions.some(d => d.template_id === 'T11'), true);
  assert.equal(suggestDirections({ topic: '随便', count: 99 }).directions.length <= 9, true);
  assert.throws(() => suggestDirections({ topic: '' }), /topic/);
});

test('corpus: optional local pack is searched, absent pack is reported not faked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-corpus-')); await mkdir(join(dir, 'thumbs'));
  await writeFile(join(dir, 'corpus.json'), JSON.stringify([
    { n: 1, id: 'a', title: '咖啡文化海报', style: '外形剖面网格', channels: ['咖啡'], prompt: '咖啡豆与杯形的剖面', source_url: 'https://example.com/1', thumb: 'thumbs/0001.webp' },
    { n: 2, id: 'b', title: '谷雨新茶', style: '中央光隙', channels: ['谷雨', '茶叶'], prompt: '两侧色域夹出通道', source_url: 'https://example.com/2' }]));
  const before = process.env.FORESTQ_CORPUS_DIR; process.env.FORESTQ_CORPUS_DIR = dir; resetCorpusCache();
  try {
    const hit = searchCorpus('咖啡 海报'); assert.equal(hit.available, true); assert.equal(hit.results[0].n, 1); assert.ok(hit.results[0].image.endsWith('0001.webp'));
    assert.equal(searchCorpus('茶', { channel: '谷雨' }).results[0].n, 2); assert.equal(getRecord(2).style, '中央光隙');
    assert.match((await runTool('get_prompt', { record: 2 })).content[0].text, /两侧色域夹出通道/); assert.equal((await runTool('get_prompt', { record: 99 })).isError, true);
    assert.match((await runTool('suggest_directions', { topic: '咖啡海报' })).content[0].text, /相近案例/);
    process.env.FORESTQ_CORPUS_DIR = join(dir, 'nope'); resetCorpusCache();
    assert.equal(searchCorpus('咖啡').available, false); assert.match((await runTool('search_prompts', { query: '咖啡' })).content[0].text, /No local corpus pack/);
  } finally { if (before === undefined) delete process.env.FORESTQ_CORPUS_DIR; else process.env.FORESTQ_CORPUS_DIR = before; resetCorpusCache(); }
});

test('MCP exposes the direction workflow tools', () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['suggest_directions', 'compose_prompt', 'generate_image', 'search_prompts', 'get_prompt', 'build_prompt', 'check_backend', 'list_catalog']);
});

test('png: transparent regions are flattened onto a solid background, opaque files are left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-')); const file = join(dir, 'a.png');
  await writeFile(file, encodePng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]), 4));
  const r = await flattenAlpha(file, { background: '#ffffff' });
  assert.equal(r.flattened, true); assert.equal(r.transparent, 0.5);
  const out = decodePng(await readFile(file)); assert.equal(out.type, 2); assert.deepEqual([...out.pixels], [255, 0, 0, 255, 255, 255]);
  await writeFile(file, encodePng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), 4));
  assert.equal((await flattenAlpha(file)).flattened, false); assert.equal(decodePng(await readFile(file)).type, 6);
  await writeFile(file, encodePng(2, 1, Buffer.from([255, 0, 0, 0, 0, 0, 0, 0]), 4));
  await flattenAlpha(file, { background: '#fff4e0' }); assert.deepEqual([...decodePng(await readFile(file)).pixels].slice(3, 6), [255, 244, 224]);
});

test('generate_image asks for an opaque background and flattens any transparency the model returns', async () => {
  process.env.FAKE_RELAY_MODE = 'alpha';
  try {
    const dir = await mkdtemp(join(tmpdir(), 'qci-'));
    const r = await runTool('generate_image', { prompt: 'a poster', out_dir: dir, file_name: 'flat' });
    assert.equal(r.isError, undefined); assert.match(r.content[0].text, /flattened onto the background/);
    const side = JSON.parse(await readFile(join(dir, 'flat.json'), 'utf8')); assert.equal(side.flattened_transparency, true); assert.match(side.prompt, /背景不透明/);
    assert.equal(decodePng(await readFile(join(dir, 'flat.png'))).type, 2);
    const keep = await runTool('generate_image', { prompt: 'a sticker', out_dir: dir, file_name: 'sticker', transparent_background: true });
    assert.doesNotMatch(keep.content[0].text, /flattened/); assert.equal(decodePng(await readFile(join(dir, 'sticker.png'))).type, 6);
    assert.doesNotMatch(JSON.parse(await readFile(join(dir, 'sticker.json'), 'utf8')).prompt, /背景不透明/);
    assert.equal(last().json.background, 'transparent');
  } finally { delete process.env.FAKE_RELAY_MODE; }
});

test('templates: a copy set given as ｜-separated lines becomes an exact whitelist', () => {
  const c = composePrompt({ template_id: 'T06-1', variables: { topic: '社区咖啡市集', subject: '咖啡壶与小鸟', headline: '赶集', copy: '社区咖啡市集｜5月24日—26日 · 老仓库' } });
  assert.equal(c.text_mode, 'exact_short'); assert.match(c.prompt, /“赶集”、“社区咖啡市集”、“5月24日—26日 · 老仓库”/); assert.match(c.prompt, /除这些之外不生成任何其他文字/);
});

// ---------------------------------------------------------------- relay backend

test('relay: images/generations gets model, prompt, bearer key; sidecar records the backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-'));
  const r = await runTool('generate_image', { prompt: 'a fox', preset: 'xiaohongshu', out_dir: dir, file_name: 'fox', quality: 'high' });
  assert.equal(r.isError, undefined); const req = last();
  assert.equal(req.path, '/v1/images/generations'); assert.equal(req.auth, `Bearer ${relay.key}`);
  assert.equal(req.json.model, 'gpt-image-1'); assert.equal(req.json.quality, 'high'); assert.match(req.json.prompt, /a fox/); assert.equal(req.json.size, undefined);
  const side = JSON.parse(await readFile(join(dir, 'fox.json'), 'utf8'));
  assert.equal(side.model, 'gpt-image-1'); assert.equal(side.api_mode, 'images'); assert.match(side.relay, /^127\.0\.0\.1:/); assert.equal(side.revised_prompt, 'REVISED');
  assert.match(r.content[0].text, /with gpt-image-1 \(images\)/); assert.doesNotMatch(JSON.stringify(side), new RegExp(relay.key));
});

test('relay: chat mode is chosen for gemini/banana models, sends data-URL references, decodes markdown images', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-')); const ref = join(dir, 'ref.png'); await writeFile(ref, 'abc');
  const r = await runTool('generate_image', { prompt: 'a cat', model: 'gemini-2.5-flash-image', reference_images: [ref], out_dir: dir, file_name: 'cat' });
  assert.equal(r.isError, undefined, r.content[0].text); const req = last();
  assert.equal(req.path, '/v1/chat/completions'); assert.equal(req.json.model, 'gemini-2.5-flash-image');
  assert.equal(req.json.messages[0].content[1].image_url.url, `data:image/png;base64,${Buffer.from('abc').toString('base64')}`);
  assert.deepEqual(await imageSize(join(dir, 'cat.png')), { width: 2, height: 1 });
  await runTool('generate_image', { prompt: 'x', model: 'gpt-image-1', api_mode: 'chat', out_dir: dir, file_name: 'forced' }); assert.equal(last().path, '/v1/chat/completions');
});

test('relay: images returned as URLs are downloaded (images and chat)', async () => {
  process.env.FAKE_RELAY_MODE = 'url';
  try {
    const dir = await mkdtemp(join(tmpdir(), 'qci-'));
    assert.equal((await runTool('generate_image', { prompt: 'x', out_dir: dir, file_name: 'u1' })).isError, undefined);
    assert.equal((await runTool('generate_image', { prompt: 'x', model: 'nano-banana', out_dir: dir, file_name: 'u2' })).isError, undefined);
    assert.deepEqual((await readdir(dir)).filter(f => f.endsWith('.png')).sort(), ['u1.png', 'u2.png']);
  } finally { delete process.env.FAKE_RELAY_MODE; }
});

test('relay: 5xx is retried, 401 is not and the key never leaks into the error', async () => {
  process.env.FAKE_RELAY_MODE = 'fail500';
  try { const r = await runTool('generate_image', { prompt: 'x', out_dir: await mkdtemp(join(tmpdir(), 'qci-')) }); assert.equal(r.isError, undefined, r.content[0].text); }
  finally { delete process.env.FAKE_RELAY_MODE; }
  process.env.FORESTQ_IMAGEGEN_API_KEY = 'sk-wrong-key-123456';
  try {
    const n = relay.requests.length; const r = await runTool('generate_image', { prompt: 'x', out_dir: await mkdtemp(join(tmpdir(), 'qci-')) });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /HTTP 401/); assert.match(r.content[0].text, /API key/); assert.doesNotMatch(r.content[0].text, /sk-wrong-key-123456/); assert.equal(relay.requests.length - n, 1);
  } finally { process.env.FORESTQ_IMAGEGEN_API_KEY = relay.key; }
  delete process.env.FORESTQ_IMAGEGEN_API_KEY;
  try { const r = await runTool('generate_image', { prompt: 'x', out_dir: await mkdtemp(join(tmpdir(), 'qci-')) }); assert.equal(r.isError, true); assert.match(r.content[0].text, /no API key/); }
  finally { process.env.FORESTQ_IMAGEGEN_API_KEY = relay.key; }
});

test('relay: crop_to_ratio centre-crops a fixed-size result to the requested ratio', async () => {
  process.env.FAKE_RELAY_MODE = 'tall';
  try {
    const dir = await mkdtemp(join(tmpdir(), 'qci-'));
    const plain = await runTool('generate_image', { prompt: 'x', aspect_ratio: '1:1', out_dir: dir, file_name: 'a' }); assert.match(plain.content[0].text, /ratio differs/);
    const r = await runTool('generate_image', { prompt: 'x', aspect_ratio: '1:1', crop_to_ratio: true, out_dir: dir, file_name: 'b' });
    assert.match(r.content[0].text, /2×2.*centre-cropped from 2×3/); assert.deepEqual(await imageSize(join(dir, 'b.png')), { width: 2, height: 2 });
  } finally { delete process.env.FAKE_RELAY_MODE; }
});

test('relay: size strategy maps ratios to sizes the model accepts', () => {
  assert.equal(pickSize({ ratio: '3:4', model: 'gpt-image-1' }), '1024x1536'); assert.equal(pickSize({ ratio: '16:9', model: 'gpt-image-1' }), '1536x1024');
  assert.equal(pickSize({ ratio: '1:1', model: 'openai/gpt-image-1' }), '1024x1024'); assert.equal(pickSize({ ratio: '9:16', model: 'dall-e-3' }), '1024x1792');
  assert.equal(pickSize({ ratio: '3:4', model: 'flux-pro' }), undefined); assert.equal(pickSize({ ratio: '3:4', model: 'flux-pro', strategy: 'exact' }), '1088x1456');
  assert.equal(pickSize({ ratio: '3:4', model: 'gpt-image-1', size: '2048×2048' }), '2048x2048'); assert.equal(pickSize({ model: 'gpt-image-1', strategy: 'auto' }), 'auto');
  assert.throws(() => pickSize({ ratio: '1:1', model: 'x', strategy: 'huge' }), /size_strategy/);
});

test('relay: config priority is args > env > file; base URLs are normalised', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qci-')); const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ base_url: 'https://file.example.com', api_key: 'sk-file', model: 'flux-pro', extra_body: { seed: 7 } }));
  const env = { ...process.env }; process.env.FORESTQ_IMAGEGEN_CONFIG = file; delete process.env.FORESTQ_IMAGEGEN_BASE_URL; delete process.env.FORESTQ_IMAGEGEN_API_KEY;
  try {
    let c = resolveConfig(); assert.equal(c.base_url, 'https://file.example.com/v1'); assert.equal(c.api_key, 'sk-file'); assert.equal(c.mode, 'images'); assert.deepEqual(c.extra_body, { seed: 7 });
    process.env.FORESTQ_IMAGEGEN_MODEL = 'gemini-3-pro-image-preview'; c = resolveConfig(); assert.equal(c.model, 'gemini-3-pro-image-preview'); assert.equal(c.mode, 'chat');
    assert.equal(resolveConfig({ model: 'dall-e-3' }).mode, 'images');
  } finally { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
  assert.equal(normalizeBaseUrl('https://relay.cn/v1/chat/completions'), 'https://relay.cn/v1'); assert.equal(normalizeBaseUrl('https://relay.cn/api/v1/'), 'https://relay.cn/api/v1');
});

test('relay: chat messages in different shapes yield their images', () => {
  const b64 = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(imagesFromChatMessage({ content: `ok ![a](https://x.cn/a.png) and ${b64}` }).sources.sort(), [b64, 'https://x.cn/a.png'].sort());
  assert.deepEqual(imagesFromChatMessage({ content: 'done', images: [{ type: 'image_url', image_url: { url: b64 } }] }).sources, [b64]);
  assert.deepEqual(imagesFromChatMessage({ content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x.cn/b.webp?sig=1' } }] }).sources, ['https://x.cn/b.webp?sig=1']);
  assert.deepEqual(imagesFromChatMessage({ content: [{ inline_data: { mime_type: 'image/jpeg', data: 'AAA' } }] }).sources, ['data:image/jpeg;base64,AAA']);
  assert.deepEqual(imagesFromChatMessage({ content: 'no picture here' }).sources, []);
});

test('check_backend lists models and flags a missing key', async () => {
  const ok = await runTool('check_backend', {}); assert.equal(ok.isError, undefined); assert.match(ok.content[0].text, /key accepted, 3 models/); assert.match(ok.content[0].text, /model "gpt-image-1" is listed/); assert.match(ok.content[0].text, /sk-te…6789/);
  const list = await runTool('list_catalog'); assert.match(list.content[0].text, /## backend/);
});
