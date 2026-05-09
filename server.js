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
// Models:  google/nano-banana (cheap fast), google/nano-banana-pro (4K), nano-banana-2

const KIE_BASE = 'https://api.kie.ai';

async function kieSubmit({ model, input }) {
  if (!CFG.kieKey) throw new Error('KIE_API_KEY not set — run keou_setup or visit ' + SIGNUP_KIE);
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${CFG.kieKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) {
    throw new Error(`KIE.AI ${res.status}: ${json?.msg || json?.message || 'submit failed'}`);
  }
  return { provider: 'kie', taskId: json.data?.taskId, model };
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

// ─── Smart routing ──────────────────────────────────────────────────────────

function pickProvider(preferred) {
  if (preferred === 'kie' && CFG.kieKey) return 'kie';
  if (preferred === 'fal' && CFG.falKey) return 'fal';
  if (preferred === 'kie' && !CFG.kieKey) throw new Error(`KIE selected but KIE_API_KEY missing — sign up at ${SIGNUP_KIE}`);
  if (preferred === 'fal' && !CFG.falKey) throw new Error(`FAL selected but FAL_API_KEY missing — sign up at ${SIGNUP_FAL}`);
  // auto: prefer KIE (cheaper)
  if (CFG.kieKey) return 'kie';
  if (CFG.falKey) return 'fal';
  throw new Error(`No provider configured. Run keou_setup, or sign up at ${SIGNUP_KIE} (cheapest) or ${SIGNUP_FAL}.`);
}

// Model IDs verified against docs.kie.ai / fal.ai (May 2026).
const KIE_DEFAULTS = {
  image: 'google/nano-banana',           // ~$0.04 per image, fast
  imagePro: 'google/nano-banana-pro',    // ~$0.10 per image, 4K
  video: 'veo3_fast',                    // Veo 3.1 Fast (separate /api/v1/veo endpoint)
  videoPro: 'veo3',                      // Veo 3.1 Quality
};
const FAL_DEFAULTS = {
  image: 'fal-ai/flux/schnell',          // fast + cheap
  imagePro: 'fal-ai/flux-pro',           // premium quality
  edit: 'fal-ai/flux/dev/image-to-image',
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
    name: 'keou_generate_image',
    description: 'Generate an image from a text prompt (and optional source image). Routes to KIE.AI by default (cheapest, ~$0.04/img) or FAL.AI if explicitly chosen. Returns a taskId — poll keou_get_status to retrieve the result URL.',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'What to generate. Be specific about subject, lighting, style.' },
        sourceImageUrl: { type: 'string', description: 'Optional source image URL for image-to-image / reference.' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'], description: 'Default 1:1' },
        quality: { type: 'string', enum: ['fast', 'pro'], description: 'fast = cheap & quick (default), pro = 4K hi-fi' },
        provider: { type: 'string', enum: ['auto', 'kie', 'fal'], description: 'Default auto (KIE preferred for cost).' },
      },
    },
  },
  {
    name: 'keou_generate_video',
    description: 'Generate a short video from a prompt (and optional source image). Uses KIE.AI Veo 3.1. After submit, poll keou_get_status with provider="kie-veo".',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        sourceImageUrl: { type: 'string', description: 'Optional source image for image-to-video.' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16'], description: 'Default 16:9.' },
        quality: { type: 'string', enum: ['fast', 'pro'], description: 'fast = veo3_fast (default), pro = veo3 (Quality)' },
      },
    },
  },
  {
    name: 'keou_remix_image',
    description: 'Re-imagine an existing image with a new prompt (image-to-image). Keeps composition, swaps style/subject as directed.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl', 'prompt'],
      properties: {
        imageUrl: { type: 'string' },
        prompt: { type: 'string', description: 'How to remix the image.' },
        aspectRatio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        provider: { type: 'string', enum: ['auto', 'kie', 'fal'] },
      },
    },
  },
  {
    name: 'keou_upscale_image',
    description: 'Upscale an image (FAL.AI clarity-upscaler). Requires FAL_API_KEY.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string' },
        scale: { type: 'integer', enum: [2, 4], description: 'Default 2x' },
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
        model: { type: 'string', description: 'Required for FAL provider (e.g. fal-ai/flux/schnell)' },
      },
    },
  },

  // ─── PREMIUM (Keou Pro) — funnel toward https://keou.systems/pro ────────
  {
    name: 'keou_pack_30_variants',
    description: 'PREMIUM. Fan one source image into 30 format-perfect variants in parallel (Instagram square, story, reel, TikTok, ad creative, banners, etc.) — what would take 25 hours by hand. Requires a Keou Pro account ($19/mo, 15 free generations to start). Run this tool to learn more.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceImageUrl: { type: 'string' },
        packType: { type: 'string', enum: ['lifestyle', 'studio', 'social', 'ads'] },
      },
    },
  },
  {
    name: 'keou_brand_kit_apply',
    description: 'PREMIUM. Apply your brand colors, fonts, logo placement, and style across all generations automatically. Requires Keou Pro.',
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

  keou_generate_image: async ({ prompt, sourceImageUrl, aspectRatio = '1:1', quality = 'fast', provider = 'auto' }) => {
    const p = pickProvider(provider);
    if (p === 'kie') {
      const model = quality === 'pro' ? KIE_DEFAULTS.imagePro : KIE_DEFAULTS.image;
      const input = { prompt, image_size: aspectRatio };
      if (sourceImageUrl) input.image_urls = [sourceImageUrl];
      return kieSubmit({ model, input });
    }
    // fal
    const model = sourceImageUrl ? FAL_DEFAULTS.edit : (quality === 'pro' ? FAL_DEFAULTS.imagePro : FAL_DEFAULTS.image);
    const sizeMap = { '1:1': 'square', '3:4': 'portrait_4_3', '4:3': 'landscape_4_3', '9:16': 'portrait_16_9', '16:9': 'landscape_16_9', '21:9': 'landscape_16_9' };
    const input = { prompt, image_size: sizeMap[aspectRatio] || 'square' };
    if (sourceImageUrl) input.image_url = sourceImageUrl;
    return falSubmit({ model, input });
  },

  keou_generate_video: async ({ prompt, sourceImageUrl, aspectRatio = '16:9', quality = 'fast' }) => {
    if (!CFG.kieKey) throw new Error(`Video requires KIE.AI key — sign up at ${SIGNUP_KIE}`);
    const model = quality === 'pro' ? KIE_DEFAULTS.videoPro : KIE_DEFAULTS.video;
    return kieVeoSubmit({ prompt, model, aspectRatio, imageUrl: sourceImageUrl });
  },

  keou_remix_image: async ({ imageUrl, prompt, aspectRatio, provider = 'auto' }) => {
    return HANDLERS.keou_generate_image({ prompt, sourceImageUrl: imageUrl, aspectRatio, provider });
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

  // ─── PREMIUM stubs (funnel) ─────────────────────────────────────────────
  keou_pack_30_variants: async () => {
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
    // TODO Phase 2: implement real call to Keou agency /api/pack
    return { locked: false, todo: 'Premium pack generation will call Keou agency API in Phase 2.' };
  },

  keou_brand_kit_apply: async () => {
    if (!CFG.keouKey) {
      return {
        locked: true,
        feature: 'Auto-apply your brand colors, fonts, logo across all generations',
        upgradeUrl: SIGNUP_KEOU,
      };
    }
    return { locked: false, todo: 'Brand kit will call Keou agency API in Phase 2.' };
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
process.stderr.write(`[keou-mcp v0.3.0] connected — providers: ${have.join(', ') || 'none (run keou_setup)'}\n`);
