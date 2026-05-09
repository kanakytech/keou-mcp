#!/usr/bin/env node
/**
 * Keou MCP — open-source bridge between Claude (Code/Desktop) and the best
 * AI image/video providers (KIE.AI, FAL.AI). Bring Your Own Key.
 *
 * Free tier   : 6 tools (BYOK direct to providers)
 * Premium tier: keou_pack, keou_brand_kit (require Keou Pro account)
 *
 * Config: env vars in .mcp.json, or fallback ~/.keou-mcp/config.json
 *   KIE_API_KEY        — sign up at https://kie.ai
 *   FAL_API_KEY        — sign up at https://fal.ai
 *   KEOU_API_KEY       — optional, unlocks premium tools (https://keou.systems/pro)
 *   KEOU_API_URL       — optional, default https://keou-agency.up.railway.app
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Config loading ─────────────────────────────────────────────────────────
// Priority: env vars > ~/.keou-mcp/config.json > undefined

const CONFIG_DIR = join(homedir(), '.keou-mcp');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function loadConfig() {
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { fileCfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { process.stderr.write(`[keou-mcp] warn: config.json unreadable (${e.message})\n`); }
  }
  return {
    kieKey:  process.env.KIE_API_KEY  || fileCfg.kieKey  || null,
    falKey:  process.env.FAL_API_KEY  || fileCfg.falKey  || null,
    keouKey: process.env.KEOU_API_KEY || fileCfg.keouKey || null,
    keouUrl: (process.env.KEOU_API_URL || fileCfg.keouUrl || 'https://keou-agency.up.railway.app').replace(/\/$/, ''),
  };
}
let CFG = loadConfig();

async function saveConfig(patch) {
  if (!existsSync(CONFIG_DIR)) await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...CFG, ...patch };
  await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  CFG = loadConfig();
}

// ─── Provider signup URLs ──────────────────────────────────────────────────
// Default URLs include the maintainer's referral params — funds ongoing
// development. Forks can override via env (KIE_SIGNUP_URL / FAL_SIGNUP_URL /
// KEOU_SIGNUP_URL) to plug their own referral codes without editing the source.
const SIGNUP_KIE  = process.env.KIE_SIGNUP_URL  || 'https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793';
const SIGNUP_FAL  = process.env.FAL_SIGNUP_URL  || 'https://fal.ai';
const SIGNUP_KEOU = process.env.KEOU_SIGNUP_URL || 'https://keou.systems/pro';

// ─── Inline rendering helpers ───────────────────────────────────────────────
// MCP supports `image` and `audio` content blocks — base64 payload + MIME type.
// When a tool finishes a render, we fetch the result URL and embed the bytes
// directly so Claude renders the image inline in the chat (no link click).
// Videos: MCP has no native `video` block, so we keep them as a clickable URL.

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const INLINE_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg']);
// Anthropic API caps individual image attachments at 5 MB. We aim for 4 MB to
// keep headroom for base64 overhead and request envelope.
const INLINE_MAX_BYTES = 4 * 1024 * 1024;
const INLINE_FETCH_TIMEOUT_MS = 30_000;
const RECOMPRESS_QUALITIES = [85, 75, 65, 55]; // progressive JPG quality fallback

function inferMimeFromUrl(url) {
  const ext = (url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  })[ext] || null;
}

/**
 * Fetch a URL and turn it into an MCP image OR audio content block. Returns
 * null on any failure (non-200, unsupported type, oversized, timeout) so the
 * caller can fall back to a text-with-URL block.
 */
async function fetchAsContentBlock(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INLINE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    let mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || inferMimeFromUrl(url);
    if (!mimeType) return null;
    const lower = mimeType.toLowerCase();
    const kind = INLINE_IMAGE_TYPES.has(lower) ? 'image' : INLINE_AUDIO_TYPES.has(lower) ? 'audio' : null;
    if (!kind) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    // Audio: pass through if under cap, drop otherwise (no transcoding).
    if (kind === 'audio') {
      if (buf.byteLength > INLINE_MAX_BYTES) return null;
      return { type: 'audio', data: buf.toString('base64'), mimeType };
    }

    // Image: if under cap, ship as-is. Otherwise recompress to JPG with
    // progressive quality fallback so the user always gets an inline render
    // even for 4K source PNGs that vastly exceed the API attachment cap.
    if (buf.byteLength <= INLINE_MAX_BYTES) {
      return { type: 'image', data: buf.toString('base64'), mimeType };
    }
    const recompressed = await recompressImageForInline(buf);
    if (!recompressed) return null;
    return { type: 'image', data: recompressed.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function recompressImageForInline(inputBuf) {
  // Try a sequence of quality drops first, then progressively scale dimensions
  // down if quality alone can't bring the file under the cap.
  for (const scale of [1, 0.85, 0.7, 0.55]) {
    let pipeline = sharp(inputBuf, { failOn: 'none' }).rotate();
    if (scale < 1) {
      const meta = await sharp(inputBuf).metadata();
      const w = Math.round((meta.width || 2048) * scale);
      pipeline = pipeline.resize({ width: w });
    }
    for (const q of RECOMPRESS_QUALITIES) {
      try {
        const out = await pipeline.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
        if (out.byteLength <= INLINE_MAX_BYTES) return out;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Backward-compatible alias — older call sites used the image-only name.
const fetchAsImageBlock = fetchAsContentBlock;

/**
 * Build an MCP `content` array from a status payload. Inlines image URLs as
 * image blocks; falls back to a text block listing URLs if inlining fails or
 * the URL is a video.
 */
async function buildResultContent(status, { headerText } = {}) {
  const urls = status?.resultUrls || [];
  const blocks = [];
  if (headerText) blocks.push({ type: 'text', text: headerText });

  let inlinedCount = 0;
  for (const url of urls) {
    const block = await fetchAsContentBlock(url);
    if (block) {
      blocks.push(block);
      inlinedCount++;
    } else {
      // Video / oversized / fetch failure → keep as a clickable text URL
      blocks.push({ type: 'text', text: url });
    }
  }

  // Append a compact metadata footer so the assistant can poll/cite later
  const meta = { taskId: status?.taskId, provider: status?.provider, state: status?.state };
  if (status?.error) meta.error = status.error;
  blocks.push({ type: 'text', text: '```json\n' + JSON.stringify(meta, null, 2) + '\n```' });

  return { content: blocks, _meta: { inlined: inlinedCount, totalUrls: urls.length } };
}

// ─── KIE.AI provider ────────────────────────────────────────────────────────
// Submit:  POST https://api.kie.ai/api/v1/jobs/createTask
// Status:  GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...
//
// Models (these match what Keou Systems uses in production):
//   - nano-banana-pro (Gemini 3 Pro Image, 2K/4K) — primary image generation.
//     Body shape: { model, input: JSON-stringified-object } — note the
//     stringified input, KIE expects this for the nano-banana family.
//   - flux-2/pro-image-to-image — for polish, remix, edit-with-prompt.
//     Body shape: { model, input: object } — standard format.

const KIE_BASE = 'https://api.kie.ai';

async function kieRawSubmit(body) {
  if (!CFG.kieKey) throw new Error('KIE_API_KEY not set — run keou_setup or visit ' + SIGNUP_KIE);
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${CFG.kieKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) {
    throw new Error(`KIE.AI ${res.status}: ${json?.msg || json?.message || 'submit failed'}`);
  }
  return { provider: 'kie', taskId: json.data?.taskId, model: body.model };
}

// Generate image with nano-banana-pro (premium default — matches Keou production).
// Accepts text-only prompts AND image-input prompts (for product visuals from
// a reference shot). 2K resolution by default; pass resolution: '4K' for hi-fi.
async function kieGenerateImage({ prompt, sourceImageUrls = [], aspectRatio = '1:1', resolution = '2K', outputFormat = 'png' }) {
  return kieRawSubmit({
    model: 'nano-banana-pro',
    // KIE's nano-banana-pro endpoint expects the input field as a JSON string,
    // not an object. This is non-standard but verified against Keou production.
    input: JSON.stringify({
      image_input: sourceImageUrls,
      aspect_ratio: aspectRatio,
      output_format: outputFormat,
      prompt,
      resolution,
    }),
  });
}

// Edit existing image with flux-2/pro-image-to-image — used for polish (preset
// prompts that clean up/lighten/sharpen) and remix (user-supplied prompt).
async function kieEditImage({ prompt, imageUrl, aspectRatio = '1:1', resolution = '2K' }) {
  return kieRawSubmit({
    model: 'flux-2/pro-image-to-image',
    input: { input_urls: [imageUrl], prompt, aspect_ratio: aspectRatio, resolution },
  });
}

// Upscale image with Topaz on KIE (Keou's production upscaler, not FAL).
async function kieUpscaleImage({ imageUrl, upscaleFactor = 2 }) {
  return kieRawSubmit({
    model: 'topaz/image-upscale',
    input: { image_url: imageUrl, upscale_factor: upscaleFactor },
  });
}

// Upscale video with Topaz on KIE.
async function kieUpscaleVideo({ videoUrl, upscaleFactor = 2 }) {
  return kieRawSubmit({
    model: 'topaz/video-upscale',
    input: { video_url: videoUrl, upscale_factor: upscaleFactor },
  });
}

// Text-to-speech via ElevenLabs hosted on KIE. Default voice 'Rachel'
// (calm, warm narrator) — same default Keou production uses. Caller can
// pass any ElevenLabs voice name.
async function kieTts({ text, voice = 'Rachel', stability, similarityBoost, style, speed }) {
  const input = { text, voice };
  if (stability !== undefined) input.stability = stability;
  if (similarityBoost !== undefined) input.similarity_boost = similarityBoost;
  if (style !== undefined) input.style = style;
  if (speed !== undefined) input.speed = speed;
  return kieRawSubmit({ model: 'elevenlabs/text-to-speech-turbo-2-5', input });
}

// Sound effects via ElevenLabs Sound Effects v2 on KIE.
async function kieSfx({ text, durationSeconds }) {
  const input = { text };
  if (durationSeconds) input.duration_seconds = durationSeconds;
  return kieRawSubmit({ model: 'elevenlabs/sound-effect-v2', input });
}

async function kieStatus(taskId) {
  if (!CFG.kieKey) throw new Error('KIE_API_KEY not set');
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { 'authorization': `Bearer ${CFG.kieKey}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) {
    throw new Error(`KIE.AI ${res.status}: ${json?.msg || 'status failed'}`);
  }
  const d = json.data || {};
  const ready = d.state === 'success';
  const failed = d.state === 'fail';
  let resultUrls = [];
  if (ready && d.resultJson) {
    try {
      const parsed = JSON.parse(d.resultJson);
      // KIE.AI returns the result under different keys depending on the model
      // family (image vs video vs audio). Try each in order — same scan order
      // Keou uses in production.
      resultUrls =
        (Array.isArray(parsed?.resultUrls) && parsed.resultUrls) ||
        (Array.isArray(parsed?.urls) && parsed.urls) ||
        (parsed?.resultUrl && [parsed.resultUrl]) ||
        (parsed?.result_url && [parsed.result_url]) ||
        (parsed?.output_url && [parsed.output_url]) ||
        (parsed?.outputUrl && [parsed.outputUrl]) ||
        (parsed?.video_url && [parsed.video_url]) ||
        (parsed?.videoUrl && [parsed.videoUrl]) ||
        (parsed?.image_url && [parsed.image_url]) ||
        (parsed?.imageUrl && [parsed.imageUrl]) ||
        (parsed?.audio_url && [parsed.audio_url]) ||
        (parsed?.audioUrl && [parsed.audioUrl]) ||
        (parsed?.url && [parsed.url]) ||
        [];
    } catch { /* leave empty */ }
  }
  return {
    provider: 'kie', taskId, state: d.state,
    ready, failed,
    resultUrls,
    error: failed ? (d.failMsg || d.failCode) : null,
    creditsConsumed: d.creditsConsumed,
    progress: d.progress,
  };
}

// KIE.AI Veo3 video — separate endpoint family
//   Submit: POST /api/v1/veo/generate     body: { prompt, model, aspect_ratio, image_url? }
//   Status: GET  /api/v1/veo/record-info?taskId=...
//   Status codes: 0 generating · 1 success · 2/3 failed
async function kieVeoSubmit({ prompt, model = 'veo3_fast', aspectRatio = '16:9', imageUrl }) {
  if (!CFG.kieKey) throw new Error('KIE_API_KEY not set — run keou_setup or visit ' + SIGNUP_KIE);
  const body = { prompt, model, aspect_ratio: aspectRatio };
  if (imageUrl) body.image_url = imageUrl;
  const res = await fetch(`${KIE_BASE}/api/v1/veo/generate`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${CFG.kieKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) {
    throw new Error(`KIE.AI Veo ${res.status}: ${json?.msg || 'submit failed'}`);
  }
  return { provider: 'kie-veo', taskId: json.data?.taskId, model };
}

async function kieVeoStatus(taskId) {
  if (!CFG.kieKey) throw new Error('KIE_API_KEY not set');
  const res = await fetch(`${KIE_BASE}/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`, {
    headers: { 'authorization': `Bearer ${CFG.kieKey}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) throw new Error(`KIE.AI Veo ${res.status}: ${json?.msg || 'status failed'}`);
  const d = json.data || {};
  const flag = d.successFlag;
  const ready = flag === 1;
  const failed = flag === 2 || flag === 3;
  const resultUrls = ready ? (d.response?.resultUrls || []) : [];
  return {
    provider: 'kie-veo', taskId,
    state: ready ? 'success' : failed ? 'fail' : 'generating',
    ready, failed, resultUrls,
    error: failed ? (d.errorMessage || d.errorCode) : null,
    fallbackUsed: d.fallbackFlag,
  };
}

// ─── FAL.AI provider ────────────────────────────────────────────────────────
// Submit:  POST https://queue.fal.run/<model-id>
// Status:  GET  https://queue.fal.run/<model-id>/requests/<id>/status
// Result:  GET  https://queue.fal.run/<model-id>/requests/<id>

const FAL_BASE = 'https://queue.fal.run';

async function falSubmit({ model, input }) {
  if (!CFG.falKey) throw new Error('FAL_API_KEY not set — run keou_setup or visit ' + SIGNUP_FAL);
  const res = await fetch(`${FAL_BASE}/${model}`, {
    method: 'POST',
    headers: {
      'authorization': `Key ${CFG.falKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`FAL.AI ${res.status}: ${json?.detail || json?.error || 'submit failed'}`);
  return { provider: 'fal', taskId: json.request_id, model, statusUrl: json.status_url, responseUrl: json.response_url };
}

async function falStatus(model, requestId) {
  if (!CFG.falKey) throw new Error('FAL_API_KEY not set');
  const sRes = await fetch(`${FAL_BASE}/${model}/requests/${requestId}/status`, {
    headers: { 'authorization': `Key ${CFG.falKey}` },
  });
  const sJson = await sRes.json().catch(() => ({}));
  const ready = sJson.status === 'COMPLETED';
  const failed = sJson.status === 'FAILED' || sJson.status === 'CANCELLED';

  let resultUrls = [];
  if (ready) {
    const rRes = await fetch(`${FAL_BASE}/${model}/requests/${requestId}`, {
      headers: { 'authorization': `Key ${CFG.falKey}` },
    });
    const rJson = await rRes.json().catch(() => ({}));
    resultUrls = (rJson.images || []).map(i => i.url);
    if (rJson.video?.url) resultUrls.push(rJson.video.url);
  }
  return {
    provider: 'fal', taskId: requestId, state: sJson.status,
    ready, failed,
    resultUrls,
    error: failed ? (sJson.error || 'failed') : null,
  };
}

// ─── Routing notes ──────────────────────────────────────────────────────────
// Image-gen / polish / remix / adapt → always KIE.AI (nano-banana-pro and
//   flux-2/pro-image-to-image — Keou's production stack).
// Upscale → always FAL.AI (clarity-upscaler — KIE has no first-party upscaler).
// Video → KIE.AI (Veo 3.1) by default; offers fast/pro switch via the
//   keou_generate_video tool's `quality` parameter.

// Model IDs aligned with Keou Systems production stack.
//   Image gen:  nano-banana-pro (Gemini 3 Pro Image, 2K/4K)
//   Image edit: flux-2/pro-image-to-image (polish, remix, brand application)
//   Video:      veo3_fast / veo3 (Veo 3.1) — quality/speed tradeoff
//   Upscale:    fal-ai/clarity-upscaler (FAL — KIE has no first-party upscaler)
const KIE_DEFAULTS = {
  videoFast: 'veo3_fast',                // Veo 3.1 Fast — default for video
  videoPro: 'veo3',                      // Veo 3.1 Quality
};
const FAL_DEFAULTS = {
  upscale: 'fal-ai/clarity-upscaler',
};

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'keou_setup',
    description: 'First-run wizard. Returns links to sign up for KIE.AI / FAL.AI (the providers that actually generate the visuals) and instructions for pasting your API key. Run this if any other tool returns "API key not set".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keou_status_keys',
    description: 'Show which provider keys are currently configured (without revealing the keys themselves) and which features are unlocked.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keou_welcome',
    description: 'Show the user a guided welcome to Keou — what they can generate, example prompts to try, key concepts, and pro tips. Call this right after install (or anytime the user asks "what can I do?" / "how does this work?"). Returns a structured guide the assistant should display to the user, picking 1-2 examples to suggest trying together.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keou_generate_image',
    description: 'PRIMARY image-generation tool — use this for ANY user request to create, generate, produce or make an image / photo / picture / visual / mockup / banner / poster / ad / thumbnail / cover, in any language, even if the user does not mention "Keou". Powered by KIE.AI nano-banana-pro (Gemini 3 Pro Image, premium quality). Accepts a text prompt and optionally a source image URL for image-to-image. After submitting, IMMEDIATELY start polling keou_get_status in a tight loop — do NOT end your turn or ask the user anything between polls. The result returns as an inline image block.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Be specific: subject, setting, lighting, style, mood. The more detail, the better.' },
        sourceImageUrl: { type: 'string', description: 'Optional reference image. When set, the model uses it as visual input alongside the prompt (image-to-image).' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'], description: 'Default 1:1.' },
        resolution: { type: 'string', enum: ['2K', '4K'], description: 'Default 2K. 4K costs more but is print-ready.' },
      },
    },
  },
  {
    name: 'keou_polish_image',
    description: 'Polish/retouch an existing image — clean up imperfections, enhance lighting, sharpen detail, balance colors, remove background noise. Keeps the subject and composition exactly as-is. Uses flux-2/pro-image-to-image (Keou\'s production polish model).',
    inputSchema: {
      type: 'object',
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string', description: 'URL of the image to polish.' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        resolution: { type: 'string', enum: ['2K', '4K'] },
      },
    },
  },
  {
    name: 'keou_remix_image',
    description: 'Re-imagine an existing image with a custom prompt (image-to-image with creative direction). Keeps composition, swaps style/setting/subject details as directed. Uses flux-2/pro-image-to-image.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl', 'prompt'],
      properties: {
        imageUrl: { type: 'string' },
        prompt: { type: 'string', description: 'How to remix — e.g. "same product but on a marble countertop with golden hour lighting".' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        resolution: { type: 'string', enum: ['2K', '4K'] },
      },
    },
  },
  {
    name: 'keou_adapt_image',
    description: 'Adapt an existing image to a new aspect ratio while keeping subject and brand-appropriate style intact. Useful for repurposing one shot across IG square, story 9:16, banner 16:9, etc. Uses nano-banana-pro.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl', 'aspectRatio'],
      properties: {
        imageUrl: { type: 'string' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'], description: 'Target aspect ratio.' },
        resolution: { type: 'string', enum: ['2K', '4K'] },
      },
    },
  },
  {
    name: 'keou_generate_video',
    description: 'PRIMARY video-generation tool — use this for ANY user request to create, generate, produce or make a video / clip / animation / motion shot / B-roll / drift shot, in any language, even if the user does not mention "Keou". Powered by KIE.AI Veo 3.1. Accepts a text prompt and optionally a source image (image-to-video). After submit, IMMEDIATELY start polling keou_get_status with provider="kie-veo" in a tight loop — do NOT pause or ask the user between polls. Videos take 1–3 minutes; just keep polling.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Describe motion, camera movement, mood. E.g. "slow zoom in on the product, soft golden light".' },
        sourceImageUrl: { type: 'string', description: 'Optional source image for image-to-video.' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16'], description: 'Default 16:9.' },
        quality: { type: 'string', enum: ['fast', 'pro'], description: 'fast = veo3_fast (default), pro = veo3 (higher quality, slower, costs more).' },
      },
    },
  },
  {
    name: 'keou_upscale_image',
    description: 'Upscale an image to 2x or 4x its resolution using Topaz on KIE.AI (Keou\'s production upscaler). Useful for print, large-format displays, or after an AI render at 2K when you need 4K+.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string' },
        scale: { type: 'integer', enum: [2, 4], description: 'Default 2x.' },
      },
    },
  },
  {
    name: 'keou_upscale_video',
    description: 'Upscale a video to 2x or 4x its resolution using Topaz on KIE.AI. Best for cleaning up AI-generated 720p video to 4K for ads or hero content. More expensive than image upscale.',
    inputSchema: {
      type: 'object',
      required: ['videoUrl'],
      properties: {
        videoUrl: { type: 'string' },
        scale: { type: 'integer', enum: [2, 4], description: 'Default 2x.' },
      },
    },
  },
  {
    name: 'keou_text_to_speech',
    description: 'PRIMARY voice / audio narration tool — use this for ANY user request to create a voice-over, narration, TTS, audio reading, podcast intro, doublage, voix off, in any language. Generates voice audio via ElevenLabs Turbo v2.5 (hosted on KIE.AI). Default voice "Rachel" (calm warm narrator). After submit, IMMEDIATELY poll keou_get_status in a tight loop — do NOT pause or ask the user between polls. The MP3 renders inline as an audio block.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The script to read aloud. Plain English (or French, Spanish, etc — model is multilingual).' },
        voice: { type: 'string', description: 'ElevenLabs voice name. Default "Rachel". Try "Adam", "Antoni", "Bella", "Clyde", "Domi", "Elli", "Sam", "Charlie", etc.' },
        stability: { type: 'number', description: '0–1. Higher = more consistent, lower = more expressive. Default ~0.5.' },
        similarityBoost: { type: 'number', description: '0–1. Higher = closer to source voice character.' },
        style: { type: 'number', description: '0–1. Style exaggeration.' },
        speed: { type: 'number', description: '0.7–1.2. Speaking rate multiplier.' },
      },
    },
  },
  {
    name: 'keou_generate_sfx',
    description: 'PRIMARY sound-effect tool — use this for ANY user request to create a sound effect, bruitage, SFX, ambient sound, foley, in any language. E.g. "soft camera shutter click", "thunderstorm distant", "champagne pop". Powered by ElevenLabs Sound Effects v2 (hosted on KIE.AI). After submit, IMMEDIATELY poll keou_get_status in a tight loop — do NOT pause or ask the user between polls. The audio renders inline.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Describe the sound — be specific about texture, distance, intensity.' },
        durationSeconds: { type: 'number', description: 'Optional duration in seconds (typically 1–10).' },
      },
    },
  },
  {
    name: 'keou_get_status',
    description: 'Poll a generation task. Call this in a TIGHT LOOP immediately after any submit (keou_generate_image, _video, _text_to_speech, _generate_sfx, _polish_image, _remix_image, _adapt_image, _upscale_image, _upscale_video). Do NOT end your assistant turn between polls, do NOT ask the user "should I keep polling?" — just keep calling until state==="success" (returns inline content) or "failed" (returns error). Typical timing: image 30–90s, video 1–3min, audio 5–20s. Pass back the EXACT taskId and provider from the submit response. For FAL also pass the same model string.',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'provider'],
      properties: {
        taskId: { type: 'string' },
        provider: { type: 'string', enum: ['kie', 'kie-veo', 'fal'] },
        model: { type: 'string', description: 'Required for FAL provider (e.g. fal-ai/clarity-upscaler).' },
      },
    },
  },

  // ─── PREMIUM (Keou Pro) — funnel toward https://keou.systems/pro ────────
  {
    name: 'keou_pack_30_variants',
    description: 'PREMIUM. Fan a completed source generation into N format-perfect variants in parallel (Instagram square, story, reel, TikTok, ad creative, banners). Requires a Keou Pro account ($19/mo, 15 free generations to start). FLOW: 1) call keou_generate_image, 2) poll keou_get_status until ready, 3) pass that generationId here as sourceGenerationId. Returns a packId — poll keou_pack_status.',
    inputSchema: {
      type: 'object',
      required: ['sourceGenerationId'],
      properties: {
        sourceGenerationId: { type: 'integer', description: 'ID of a completed generation from keou_generate_image (in the user\'s Keou account).' },
        packType: { type: 'string', enum: ['lifestyle', 'studio', 'social', 'ads'], description: 'Default "lifestyle".' },
        projectId: { type: 'integer', description: 'Optional project to attach the pack to.' },
      },
    },
  },
  {
    name: 'keou_pack_status',
    description: 'PREMIUM. Poll an export pack. Returns aggregate progress { total, ready, failed, done } plus per-item URLs as they complete.',
    inputSchema: {
      type: 'object',
      required: ['packId'],
      properties: { packId: { type: 'string' } },
    },
  },
  {
    name: 'keou_brand_kit_apply',
    description: 'PREMIUM (v0.5 — preview). Apply your brand colors, fonts, logo placement, and style across all generations automatically. Currently returns a coming-soon notice; pass brand details in your prompt as a workaround.',
    inputSchema: {
      type: 'object',
      properties: { brandKitId: { type: 'string' } },
    },
  },
];

// ─── Tool implementations ───────────────────────────────────────────────────

const HANDLERS = {
  keou_setup: async () => {
    const have = {
      kie: !!CFG.kieKey,
      fal: !!CFG.falKey,
      keouPro: !!CFG.keouKey,
    };
    return {
      welcome: 'Keou MCP — generate images & videos from any Claude chat.',
      currentStatus: have,
      howToConfigure: {
        option1_envVars: 'Edit your .mcp.json and add an "env" block with KIE_API_KEY and/or FAL_API_KEY. Restart Claude.',
        option2_configFile: `Create ${CONFIG_PATH} with { "kieKey": "...", "falKey": "..." }`,
      },
      providers: {
        kie: {
          why: 'Powers all Keou capabilities (image gen, polish, remix, video, upscale, TTS, SFX). $0.09/image (nano-banana-pro), free credits on signup.',
          signup: SIGNUP_KIE,
          freeCredits: 'Yes, on signup',
        },
        fal: {
          why: 'Premium quality (Flux models). More expensive (~$0.10/image) but state-of-the-art.',
          signup: SIGNUP_FAL,
          freeCredits: 'Yes, on signup',
        },
      },
      premiumUpgrade: {
        what: 'Keou Pro: batch packs (30 variants from 1 source), brand kit, history, team sharing',
        signup: SIGNUP_KEOU,
        pricing: '$19/mo — 15 free generations to start',
      },
    };
  },

  keou_status_keys: async () => ({
    kie:  CFG.kieKey  ? `configured (${CFG.kieKey.slice(0, 6)}…)` : 'not set',
    fal:  CFG.falKey  ? `configured (${CFG.falKey.slice(0, 6)}…)` : 'not set',
    keouPro: CFG.keouKey ? `configured (${CFG.keouKey.slice(0, 10)}…)` : 'not set — premium tools locked',
    unlockedTools: [
      ...(CFG.kieKey ? [
        'keou_generate_image', 'keou_polish_image', 'keou_remix_image', 'keou_adapt_image',
        'keou_generate_video', 'keou_upscale_image', 'keou_upscale_video',
        'keou_text_to_speech', 'keou_generate_sfx', 'keou_get_status', 'keou_welcome',
      ] : []),
      ...(CFG.keouKey ? ['keou_pack_30_variants', 'keou_pack_status', 'keou_brand_kit_apply'] : []),
    ],
    suggestion: !CFG.kieKey
      ? `No KIE.AI key set. Run keou_setup, or sign up at ${SIGNUP_KIE}.`
      : !CFG.keouKey
      ? `Pro tip: unlock batch packs (30 variants in parallel) → ${SIGNUP_KEOU}`
      : 'All tiers unlocked.',
  }),

  keou_welcome: async () => ({
    title: 'Welcome to Keou — your AI creative studio in Claude.',
    intro: 'You can now generate product images, videos, voice-overs, and sound effects directly from this chat. Below is the full capability map plus example prompts. The assistant should NOT dump everything — pick ONE category matching what the user wants (or ask) and offer to run a specific example with them.',

    capabilities: {
      images: {
        heading: 'Images — text-to-image, image-to-image, polish, remix, adapt',
        tools: [
          { tool: 'keou_generate_image', usage: 'Text-to-image (prompt only) OR image-to-image (prompt + sourceImageUrl). Default 1:1, 2K.', model: 'nano-banana-pro (Gemini 3 Pro Image)' },
          { tool: 'keou_polish_image', usage: 'Clean up imperfections, balance lighting, sharpen detail. Keeps composition intact.', model: 'flux-2/pro-image-to-image' },
          { tool: 'keou_remix_image', usage: 'Re-imagine an existing image with a custom prompt (new setting / mood / style).', model: 'flux-2/pro-image-to-image' },
          { tool: 'keou_adapt_image', usage: 'Re-render an existing image in a new aspect ratio (1:1 → 9:16 for stories, etc).', model: 'nano-banana-pro' },
          { tool: 'keou_upscale_image', usage: 'Upscale 2x or 4x to print-ready resolution.', model: 'topaz/image-upscale' },
        ],
      },
      video: {
        heading: 'Video — image-to-video + cinematic motion',
        tools: [
          { tool: 'keou_generate_video', usage: 'Text-to-video or image-to-video. Quality "fast" (veo3_fast, default) or "pro" (veo3 — higher fidelity, slower).', model: 'KIE.AI Veo 3.1' },
          { tool: 'keou_upscale_video', usage: 'Upscale a 720p AI video to 4K for ad / hero use.', model: 'topaz/video-upscale' },
        ],
      },
      audio: {
        heading: 'Audio — voice-over and sound effects',
        tools: [
          { tool: 'keou_text_to_speech', usage: 'Voice-over from text. Default voice "Rachel" — pass any ElevenLabs voice (Adam, Bella, Antoni, Sam, Charlie, etc). Multilingual.', model: 'ElevenLabs Turbo v2.5' },
          { tool: 'keou_generate_sfx', usage: 'Short sound effect from a text description (e.g. "soft camera shutter click", "champagne pop", "rain on window").', model: 'ElevenLabs Sound Effects v2' },
        ],
      },
      premium: {
        heading: 'Premium (require Keou Pro account)',
        tools: [
          { tool: 'keou_pack_30_variants', usage: 'Fan one finished source image into 30 format-perfect variants in parallel — IG square, story, reel, TikTok, banners, ad creatives. Saves ~25h of manual reformatting per pack.' },
          { tool: 'keou_brand_kit_apply', usage: 'Auto-apply brand colors, fonts, logo, voice across every gen. (v0.5 preview — pass brand details in prompts as a workaround for now.)' },
        ],
      },
    },

    quickStartExamples: [
      { label: 'Studio product shot', tool: 'keou_generate_image', prompt: 'Moody studio shot of a black leather wallet on dark slate, single soft key light from the right, premium luxury feel, 1:1, 2K.' },
      { label: 'Lifestyle scene from a reference', tool: 'keou_generate_image', prompt: 'Same product as in this reference, staged on a marble kitchen countertop with morning light streaming in, casual lifestyle feel.', requires: 'sourceImageUrl' },
      { label: 'Polish a rough phone shot', tool: 'keou_polish_image', requires: 'imageUrl' },
      { label: 'Remix into a different scene', tool: 'keou_remix_image', prompt: 'Reimagine this product on a sunset beach with warm orange backlight and shallow depth of field.', requires: 'imageUrl' },
      { label: 'Repurpose for IG story (9:16)', tool: 'keou_adapt_image', requires: 'imageUrl + aspectRatio: "9:16"' },
      { label: 'Cinematic 5-second product video', tool: 'keou_generate_video', prompt: 'Slow cinematic dolly-in on the product, soft golden-hour light, shallow depth of field.' },
      { label: 'Voice-over for an ad', tool: 'keou_text_to_speech', prompt: 'Made for those who notice the details. Engineered for those who don\'t.', voice: 'Adam' },
      { label: 'Foley / SFX for a video', tool: 'keou_generate_sfx', prompt: 'Soft camera shutter click followed by a single film advance.' },
      { label: 'Upscale finished image to 4K', tool: 'keou_upscale_image', requires: 'imageUrl + scale: 4' },
    ],

    keyConcepts: [
      { name: 'Generate vs Polish vs Remix vs Adapt', detail: 'Generate creates new from a prompt (± reference). Polish cleans up an existing image without changing it. Remix re-imagines with new direction. Adapt re-frames into a new aspect ratio.' },
      { name: 'Resolution: 2K vs 4K', detail: '2K is the default — fast, cheap, looks great on screen. 4K costs more but is print-ready. Use 4K only when needed.' },
      { name: 'Aspect ratios', detail: '1:1 (IG square), 9:16 (Stories / Reels / TikTok), 16:9 (banners / video), 4:3 / 3:4 (classic photo). Adapt is the fastest way to make all formats from one source.' },
      { name: 'Async by design', detail: 'Generation takes 10–60 seconds. Every tool returns a taskId — call keou_get_status with the same provider/taskId to retrieve. The assistant should poll automatically.' },
      { name: 'Inline rendering', detail: 'When ready, images and audio render directly in this chat — no clicking links. Videos render as a clickable URL (MCP has no native video block yet).' },
    ],

    proTips: [
      'Be specific in prompts: subject + setting + lighting + mood + style. Vague prompts give vague results.',
      'For brand consistency, describe your color palette, lighting style, and composition rules in every prompt.',
      'Use polish before remix when your starting image is rough — better source = better remix.',
      'Pair generate_image + generate_video + text_to_speech to make a full ad creative in one chat.',
      'Pack of 30 variants from one source is a Keou Pro feature ($19/mo) — saves ~25h per pack vs doing it manually.',
    ],

    cost: {
      heading: 'What it costs (you pay KIE.AI directly, no Keou markup on the free MCP)',
      bullets: [
        'Image — generate / polish / remix / adapt: $0.09 per image (2K), more for 4K',
        'Image upscale (Topaz): $0.12 per image',
        'Video — Veo 3.1: ~$0.25 per second (fast variant cheaper). 5-second clip ≈ $1.25',
        'Video upscale (Topaz): $0.70 per video',
        'Voice-over (TTS): $0.05 per generation',
        'Sound effect (SFX): $0.05 per generation',
      ],
      note: 'KIE.AI gives free credits on signup. The maintainer earns a 15% referral commission on referred users\' first 30 days through https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793 — that\'s how this open-source project funds itself.',
    },

    nextSteps: {
      heading: 'When single-asset workflows aren\'t enough',
      pro: 'Keou Pro ($19/mo) unlocks: pack_30_variants (one source → 30 ad-ready format variants in parallel), brand_kit_apply (auto-apply your brand system to every gen), persistent history, team sharing. → https://keou.systems/pro',
      agency: 'For studios deploying Keou under their own brand for clients: Keou Agency tier ($499/mo). Industrialize visual content production for an agency or in-house creative team. Contact k.wahuzuepro@gmail.com.',
    },

    assistantInstructions: 'IMPORTANT — be like a great Apple Genius bar employee, not a bot. Don\'t dump this whole guide on the user. Ask them what they\'re trying to make (a product photo? an ad? a voice-over for a reel?) and pick ONE matching example to run together. Walk them through it, show the output inline, then ask what\'s next. Patience over thoroughness.',
  }),

  keou_generate_image: async ({ prompt, sourceImageUrl, aspectRatio = '1:1', resolution = '2K' }) => {
    if (!CFG.kieKey) throw new Error(`Image generation requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    const sourceImageUrls = sourceImageUrl ? [sourceImageUrl] : [];
    return kieGenerateImage({ prompt, sourceImageUrls, aspectRatio, resolution });
  },

  keou_polish_image: async ({ imageUrl, aspectRatio = '1:1', resolution = '2K' }) => {
    if (!CFG.kieKey) throw new Error(`Polish requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!imageUrl) throw new Error('imageUrl required');
    const polishPrompt = 'Clean up imperfections, enhance lighting, sharpen detail, balance colors, remove distracting background noise. Keep subject and composition exactly as-is.';
    return kieEditImage({ prompt: polishPrompt, imageUrl, aspectRatio, resolution });
  },

  keou_remix_image: async ({ imageUrl, prompt, aspectRatio = '1:1', resolution = '2K' }) => {
    if (!CFG.kieKey) throw new Error(`Remix requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!imageUrl) throw new Error('imageUrl required');
    if (!prompt?.trim()) throw new Error('prompt required — describe how to remix the image');
    return kieEditImage({ prompt, imageUrl, aspectRatio, resolution });
  },

  keou_adapt_image: async ({ imageUrl, aspectRatio, resolution = '2K' }) => {
    if (!CFG.kieKey) throw new Error(`Adapt requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!imageUrl) throw new Error('imageUrl required');
    if (!aspectRatio) throw new Error('aspectRatio required (e.g. "9:16")');
    // Adapt = re-render the same subject in a new aspect ratio. Uses
    // nano-banana-pro with image_input + a minimal prompt asking it to keep
    // composition while reframing.
    const adaptPrompt = 'Adapt this image to the new aspect ratio. Keep subject, lighting, and brand-appropriate style. Recompose the framing as needed for the new ratio without distorting the subject.';
    return kieGenerateImage({
      prompt: adaptPrompt,
      sourceImageUrls: [imageUrl],
      aspectRatio,
      resolution,
    });
  },

  keou_generate_video: async ({ prompt, sourceImageUrl, aspectRatio = '16:9', quality = 'fast' }) => {
    if (!CFG.kieKey) throw new Error(`Video requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    const model = quality === 'pro' ? KIE_DEFAULTS.videoPro : KIE_DEFAULTS.videoFast;
    return kieVeoSubmit({ prompt, model, aspectRatio, imageUrl: sourceImageUrl });
  },

  keou_upscale_image: async ({ imageUrl, scale = 2 }) => {
    if (!CFG.kieKey) throw new Error(`Upscale requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!imageUrl) throw new Error('imageUrl required');
    return kieUpscaleImage({ imageUrl, upscaleFactor: scale });
  },

  keou_upscale_video: async ({ videoUrl, scale = 2 }) => {
    if (!CFG.kieKey) throw new Error(`Video upscale requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!videoUrl) throw new Error('videoUrl required');
    return kieUpscaleVideo({ videoUrl, upscaleFactor: scale });
  },

  keou_text_to_speech: async ({ text, voice = 'Rachel', stability, similarityBoost, style, speed }) => {
    if (!CFG.kieKey) throw new Error(`TTS requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!text?.trim()) throw new Error('text required');
    return kieTts({ text, voice, stability, similarityBoost, style, speed });
  },

  keou_generate_sfx: async ({ text, durationSeconds }) => {
    if (!CFG.kieKey) throw new Error(`SFX requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    if (!text?.trim()) throw new Error('text required (describe the sound)');
    return kieSfx({ text, durationSeconds });
  },

  keou_get_status: async ({ taskId, provider, model }) => {
    let status;
    if (provider === 'kie') status = await kieStatus(taskId);
    else if (provider === 'kie-veo') status = await kieVeoStatus(taskId);
    else if (provider === 'fal') {
      if (!model) throw new Error('FAL provider requires the same `model` you used at submit (e.g. fal-ai/clarity-upscaler).');
      status = await falStatus(model, taskId);
    } else {
      throw new Error('provider must be "kie", "kie-veo", or "fal"');
    }

    // Still in flight or failed → return JSON status as text. Claude polls
    // again after a short pause.
    if (!status.ready || !status.resultUrls?.length) return status;

    // Ready → fetch the result(s) and embed them inline so Claude renders
    // the image(s) directly in the chat. Videos fall through as URL text
    // (MCP has no native video block).
    return buildResultContent(status, {
      headerText: status.resultUrls.length === 1
        ? 'Done — here\'s your result:'
        : `Done — ${status.resultUrls.length} results:`,
    });
  },

  // ─── PREMIUM (Keou Pro) ────────────────────────────────────────────────
  // Both call the Keou agency API. The agency enforces the Pro plan check
  // server-side via requirePro middleware, so a free user with a valid
  // keouKey but no active Pro subscription gets a 402 with upgradeUrl.
  keou_pack_30_variants: async ({ sourceImageUrl, packType = 'lifestyle', sourceGenerationId, projectId }) => {
    if (!CFG.keouKey) {
      return {
        locked: true,
        feature: 'Pack of 30 format-perfect variants from a single source image',
        savesYou: '~25 hours of manual editing per pack',
        upgradeUrl: SIGNUP_KEOU,
        pricing: '$19/mo — 15 free generations to start',
        howToUnlock: `1. Sign up at ${SIGNUP_KEOU}\n2. Create an API key in your dashboard\n3. Add KEOU_API_KEY to your .mcp.json env block\n4. Restart Claude`,
      };
    }
    // Source must already be a completed generation in the user's Keou account.
    // Front-end flow: user calls keou_generate_image first → gets generationId,
    // waits until ready → passes that ID here.
    if (!sourceGenerationId) {
      throw new Error('sourceGenerationId is required — first call keou_generate_image, then poll keou_get_status until ready, then pass that generationId here.');
    }
    const body = { sourceGenerationId, packId: packType, projectId };
    const res = await fetch(`${CFG.keouUrl}/api/pack`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${CFG.keouKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 402) {
      return { locked: true, reason: json.error, upgradeUrl: json.upgradeUrl || SIGNUP_KEOU };
    }
    if (!res.ok) throw new Error(`Keou ${res.status}: ${json?.error || 'pack creation failed'}`);
    return { ...json, _hint: 'Poll keou_pack_status with the returned packId until done.' };
  },

  keou_pack_status: async ({ packId }) => {
    if (!CFG.keouKey) throw new Error('Keou Pro key required for pack status. Sign up: ' + SIGNUP_KEOU);
    if (!packId) throw new Error('packId required');
    const res = await fetch(`${CFG.keouUrl}/api/pack/${encodeURIComponent(packId)}/status`, {
      headers: { 'authorization': `Bearer ${CFG.keouKey}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Keou ${res.status}: ${json?.error || 'status failed'}`);

    // Pack still rendering → return JSON status as text. Done → inline every
    // ready variant as an image block so Claude shows the whole grid in chat.
    if (!json.done) return json;

    const readyUrls = (json.items || [])
      .filter(it => it.status === 'completed' && it.url)
      .map(it => it.url);
    if (!readyUrls.length) return json;

    return buildResultContent(
      { resultUrls: readyUrls, taskId: packId, provider: 'keou-pack', state: 'completed' },
      { headerText: `Pack ready — ${readyUrls.length}/${json.total} variants:` }
    );
  },

  keou_brand_kit_apply: async () => {
    if (!CFG.keouKey) {
      return {
        locked: true,
        feature: 'Auto-apply your brand colors, fonts, logo across all generations',
        upgradeUrl: SIGNUP_KEOU,
      };
    }
    // Coming in v0.5 — endpoint not yet exposed by the agency.
    return {
      comingSoon: true,
      eta: 'v0.5',
      currentWorkaround: 'Pass your brand colors / fonts as part of the prompt for now.',
    };
  },
};

// ─── MCP wiring ─────────────────────────────────────────────────────────────

// MCP `instructions` are surfaced to Claude on every session init. They tell
// the assistant when to reach for Keou tools (without the user having to
// remind it) and how to poll them autonomously to completion.
const SERVER_INSTRUCTIONS = `You have the **Keou** media-generation toolkit (KIE.AI + FAL.AI under the hood). Use it whenever the user asks you to create, generate, or produce ANY of:
- an image, photo, picture, visual, illustration, render, mockup, banner, poster, ad creative, logo background, product shot, lifestyle shot, social-media visual, story, reel cover, thumbnail
- a video, clip, animation, motion shot, drift shot, B-roll
- a voice-over, narration, TTS, audio, sound effect, SFX

Trigger keywords (non-exhaustive): "génère", "fais-moi", "crée", "image de", "photo de", "visuel", "rendu", "mockup", "vidéo de", "clip", "voix off", "TTS", "son de", "bruitage", "remix", "polish", "retouche", "upscale". Match these in any language. Do NOT wait for the user to mention "Keou" — the toolkit IS the default for any media generation request in this environment.

Tool routing:
- New image from prompt → keou_generate_image
- Reference image + new direction → keou_remix_image (creative re-imagination) OR keou_polish_image (clean-up/retouch only)
- Aspect-ratio repurpose of an existing render → keou_adapt_image
- Video → keou_generate_video
- Voice → keou_text_to_speech
- Sound FX → keou_generate_sfx
- Sharpen final → keou_upscale_image / keou_upscale_video

Polling — CRITICAL:
Every generation tool returns a taskId. After submitting, you MUST poll keou_get_status in a tight loop until state==='success' or 'failed'. Do NOT pause, do NOT ask the user "should I continue?", do NOT end the assistant turn between polls. The user expects you to just deliver the result. Typical generation: 30–90 seconds. Just keep polling.

Result delivery:
keou_get_status returns the image as an inline content block (no link). If for any reason it falls back to URL text, that means the source was unrecoverable — apologize once, share the URL, do NOT retry the same prompt without telling the user why.`;

const server = new Server(
  { name: 'keou-mcp', version: '0.8.0' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    const result = await handler(req.params.arguments || {});
    // Handler can return a pre-shaped MCP response with content[] (used by
    // tools that inline images via fetchAsImageBlock). Otherwise we serialize
    // the plain object as JSON in a text block.
    if (result && Array.isArray(result.content)) return result;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message || 'Tool execution failed' }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

const have = [];
if (CFG.kieKey) have.push('KIE');
if (CFG.falKey) have.push('FAL');
if (CFG.keouKey) have.push('Keou Pro');
process.stderr.write(`[keou-mcp v0.7.0] connected — providers: ${have.join(', ') || 'none (run keou_setup)'}\n`);
