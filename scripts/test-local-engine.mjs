/**
 * End-to-end test of the local (ComfyUI) engine — real MCP over stdio against
 * a stub ComfyUI. No real ComfyUI, no API key, CI-safe.
 *
 *   node scripts/test-local-engine.mjs
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3497;

// A 1x1 PNG so the inline-image pipeline has real bytes to embed.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (url.pathname === '/object_info/CheckpointLoaderSimple') {
    return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl-test.safetensors']] } } } });
  }
  if (url.pathname === '/object_info/UNETLoader') {
    return json({ UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors']] } } } });
  }
  if (url.pathname === '/object_info/CLIPLoader') {
    return json({ CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } } });
  }
  if (url.pathname === '/object_info/VAELoader') {
    return json({ VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors']] } } } });
  }
  if (url.pathname === '/object_info/SaveVideo') {
    return json({ SaveVideo: { input: { required: {} } } });
  }
  if (url.pathname === '/prompt') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => json({ prompt_id: 'e2e-1', number: 1 }));
    return;
  }
  if (url.pathname.startsWith('/history/')) {
    return json({ 'e2e-1': { status: { status_str: 'success', completed: true }, outputs: { 7: { images: [{ filename: 'keou_1.png', subfolder: '', type: 'output' }] } } } });
  }
  if (url.pathname === '/view') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => stub.listen(PORT, r));

const child = spawn('node', [join(ROOT, 'server.js')], {
  env: { ...process.env, COMFYUI_URL: `http://localhost:${PORT}`, KIE_API_KEY: '', FAL_API_KEY: '', KEOU_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* log line, ignore */ }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 15_000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

let failures = 0;
const ok = (l) => console.log(`  ✓ ${l}`);
const ko = (l, e) => { failures++; console.error(`  ✗ ${l} — ${e.message}`); };

try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  ok('MCP initialize');

  // No KIE key + COMFYUI_URL set → auto must route to local.
  const gen = await rpc('tools/call', { name: 'keou_generate_image', arguments: { prompt: 'a bottle on a beach' } });
  const genText = JSON.stringify(gen.result);
  assert.ok(/local/.test(genText), `expected provider local, got: ${genText.slice(0, 200)}`);
  assert.ok(genText.includes('e2e-1'), 'expected stub taskId');
  ok('keou_generate_image → local engine (auto, no key)');

  const st = await rpc('tools/call', { name: 'keou_get_status', arguments: { taskId: 'e2e-1', provider: 'local' } });
  const blocks = st.result?.content || [];
  assert.ok(blocks.some((b) => b.type === 'image' && b.data?.length > 10), `expected inline image block, got: ${JSON.stringify(blocks).slice(0, 200)}`);
  ok('keou_get_status(local) → inline image block');

  const vid = await rpc('tools/call', { name: 'keou_generate_video', arguments: { prompt: 'slow dolly-in on the bottle' } });
  const vidText = JSON.stringify(vid.result);
  assert.ok(/local/.test(vidText) && /e2e-1/.test(vidText), `video sans clé + modèles Wan présents doit partir en local, reçu: ${vidText.slice(0, 200)}`);
  ok('keou_generate_video sans clé → moteur local Wan 5B');

  const keys = await rpc('tools/call', { name: 'keou_status_keys', arguments: {} });
  assert.ok(JSON.stringify(keys.result).includes('FREE'), 'status_keys must surface the active local engine');
  ok('keou_status_keys expose le moteur local actif');
} catch (e) { ko('e2e', e); }

child.kill();
stub.close();
if (failures) { console.error(`\n  ${failures} échec(s)`); process.exit(1); }
console.log('\n  local engine e2e passed');
