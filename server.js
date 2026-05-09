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
      resultUrls = parsed?.resultUrls || parsed?.urls || (parsed?.url ? [parsed.url] : []);
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
    description: 'Generate a product image with KIE.AI nano-banana-pro (Keou\'s production model — Gemini 3 Pro Image, premium quality). Accepts a text prompt and optionally a source image URL for image-to-image generation. Returns a taskId — poll keou_get_status to retrieve the result URL.',
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
    description: 'Generate a short video with KIE.AI Veo 3.1. Accepts a text prompt and optionally a source image (image-to-video). After submit, poll keou_get_status with provider="kie-veo".',
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
    description: 'Upscale an image to 2x or 4x its resolution using FAL.AI clarity-upscaler. Requires FAL_API_KEY (separate from KIE.AI). Useful for print or large-format displays.',
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
    name: 'keou_get_status',
    description: 'Poll a generation task. Returns { ready, state, resultUrls[], error }. Pass back the EXACT taskId and provider returned by the submit call. For FAL also pass the same model string.',
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
          why: 'Cheapest provider (~$0.04/image with nano-banana). Fast. Good for batch.',
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
      ...(CFG.kieKey || CFG.falKey ? ['keou_generate_image', 'keou_generate_video', 'keou_remix_image', 'keou_upscale_image', 'keou_get_status'] : []),
      ...(CFG.keouKey ? ['keou_pack_30_variants', 'keou_brand_kit_apply'] : []),
    ],
    suggestion: !CFG.kieKey && !CFG.falKey
      ? `No provider key set. Run keou_setup, or sign up at ${SIGNUP_KIE} (cheapest).`
      : !CFG.keouKey
      ? `Pro tip: unlock batch packs (30 variants in parallel) → ${SIGNUP_KEOU}`
      : 'All tiers unlocked.',
  }),

  keou_welcome: async () => ({
    title: 'Welcome to Keou — your AI design assistant in Claude.',
    intro: 'You can now generate product images, videos, and design assets directly from this chat. Here\'s how to get the most out of it. The assistant should pick 1-2 examples below and offer to try one with the user right now — don\'t dump the whole guide.',

    quickStart: {
      heading: 'Try one of these right now',
      examples: [
        {
          label: 'Studio product shot',
          prompt: 'Generate a moody studio shot of a black leather wallet on dark slate, single soft key light from the right, premium luxury feel, 1:1, 2K.',
          tool: 'keou_generate_image',
          why: 'Best when you want a clean, high-end product image from scratch.',
        },
        {
          label: 'Lifestyle scene from a reference',
          prompt: 'Same product as in this reference, but staged on a marble kitchen countertop with morning light streaming in, casual lifestyle feel.',
          tool: 'keou_generate_image',
          requires: 'sourceImageUrl',
          why: 'Best when you have a real product photo and want it placed in a new context.',
        },
        {
          label: 'Polish a rough phone shot',
          prompt: '(no prompt needed — keou_polish_image cleans up automatically)',
          tool: 'keou_polish_image',
          requires: 'imageUrl',
          why: 'Best for cleaning up uneven lighting, distracting backgrounds, or low-light shots.',
        },
        {
          label: 'Remix into a different scene',
          prompt: 'Reimagine this product on a sunset beach with warm orange backlight and shallow depth of field.',
          tool: 'keou_remix_image',
          requires: 'imageUrl',
          why: 'Best when you have one good shot and want to multiply it into different settings.',
        },
        {
          label: 'Repurpose for IG story / TikTok (9:16)',
          prompt: '(set aspectRatio: "9:16" — keou_adapt_image reframes automatically)',
          tool: 'keou_adapt_image',
          requires: 'imageUrl + aspectRatio',
          why: 'Best when you have a finished horizontal/square shot and need a vertical version for stories or reels.',
        },
        {
          label: 'Cinematic product video',
          prompt: 'Slow cinematic dolly-in on the product, soft golden hour light, shallow depth of field, 5 seconds.',
          tool: 'keou_generate_video',
          why: 'Best for ad creatives, IG reels, hero videos. Costs more than images — use sparingly.',
        },
      ],
    },

    keyConcepts: [
      {
        name: 'Generate vs Polish vs Remix vs Adapt',
        detail: 'Generate makes a new image from a prompt (or prompt + reference). Polish cleans up an existing image without changing it. Remix re-imagines an existing image with new direction. Adapt re-frames an existing image to a different aspect ratio.',
      },
      {
        name: 'Resolution: 2K vs 4K',
        detail: '2K is the default — fast, cheap, looks great on screen. 4K costs more but is print-ready. Use 4K only when you need it.',
      },
      {
        name: 'Aspect ratios',
        detail: '1:1 (Instagram square), 9:16 (Stories / Reels / TikTok), 16:9 (banners / video), 4:3 / 3:4 (classic photo). Adapt is the fastest way to make all formats from one source.',
      },
      {
        name: 'Async by design',
        detail: 'Generation takes 10–60 seconds. Every tool returns a taskId — call keou_get_status with the same provider/taskId to check progress. The assistant should poll automatically.',
      },
    ],

    proTips: [
      'Be specific in prompts: subject + setting + lighting + mood + style. Vague prompts give vague results.',
      'For brand consistency across multiple images, describe your color palette, lighting style, and composition rules in every prompt.',
      'Use polish before remix when your starting image is rough — better source = better remix.',
      'Pack of 30 variants from one source is a Keou Pro feature ($19/mo) — saves ~25h vs doing it manually.',
    ],

    cost: {
      heading: 'What it costs (you pay KIE.AI / FAL.AI directly, no Keou markup)',
      bullets: [
        'Image gen / polish / remix / adapt: ~$0.04–0.10 per image (2K), ~$0.20–0.30 (4K)',
        'Video (Veo 3.1 fast): ~$0.40 per second of video',
        'Upscale (FAL clarity-upscaler): ~$0.05 per image',
      ],
      note: 'KIE.AI gives free credits on signup. The maintainer earns a 15% referral commission on your first 30 days through https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793 — that\'s how this stays free open source.',
    },

    nextSteps: {
      heading: 'When you outgrow single images',
      pro: 'Keou Pro ($19/mo) unlocks: pack_30_variants (one source → 30 ad-ready format variants in parallel), brand_kit_apply (auto-apply your brand colors/fonts/logo across every gen), persistent history, team sharing. https://keou.systems/pro',
      agency: 'For studios going white-label for clients: Keou Agency tier ($499/mo) deploys Keou under your brand. Contact k.wahuzuepro@gmail.com.',
    },

    assistantInstructions: 'After showing this guide, pick ONE example matching what the user seems to want (or ask if unclear), and offer to run it now. Don\'t lecture — be a friendly assistant. The user just installed something and wants to feel the magic immediately.',
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
    if (!CFG.falKey) {
      throw new Error(`Upscale runs on FAL.AI (clarity-upscaler). Set FAL_API_KEY — sign up at ${SIGNUP_FAL}.`);
    }
    return falSubmit({ model: FAL_DEFAULTS.upscale, input: { image_url: imageUrl, upscale_factor: scale } });
  },

  keou_get_status: async ({ taskId, provider, model }) => {
    if (provider === 'kie') return kieStatus(taskId);
    if (provider === 'kie-veo') return kieVeoStatus(taskId);
    if (provider === 'fal') {
      if (!model) throw new Error('FAL provider requires the same `model` you used at submit (e.g. fal-ai/flux/schnell).');
      return falStatus(model, taskId);
    }
    throw new Error('provider must be "kie", "kie-veo", or "fal"');
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
    return json;
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

const server = new Server(
  { name: 'keou-mcp', version: '0.2.1' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
  }
  try {
    const result = await handler(req.params.arguments || {});
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
process.stderr.write(`[keou-mcp v0.5.0] connected — providers: ${have.join(', ') || 'none (run keou_setup)'}\n`);
