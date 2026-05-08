#!/usr/bin/env node
/**
 * Keou MCP — exposes the Keou Agency generation API to any MCP client
 * (Claude Code / Desktop). Stdio transport, single-user (one API key per server).
 *
 * Config via env:
 *   KEOU_API_URL  — base URL (default: https://keou-agency.up.railway.app)
 *   KEOU_API_KEY  — required, format keou_<32 hex>
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API_URL = (process.env.KEOU_API_URL || 'https://keou-agency.up.railway.app').replace(/\/$/, '');
const API_KEY = process.env.KEOU_API_KEY;

if (!API_KEY) {
  process.stderr.write('[keou-mcp] KEOU_API_KEY missing — set it in your MCP config env block.\n');
  process.exit(1);
}
if (!API_KEY.startsWith('keou_')) {
  process.stderr.write('[keou-mcp] KEOU_API_KEY format invalid — expected "keou_<32 hex>".\n');
  process.exit(1);
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'authorization': `Bearer ${API_KEY}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || `HTTP ${res.status}`;
    const err = new Error(`[${method} ${path}] ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function uploadFile(filePath) {
  const buf = await readFile(filePath);
  const name = basename(filePath);
  const ext = name.split('.').pop()?.toLowerCase() || 'png';
  const mimes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  const type = mimes[ext];
  if (!type) throw new Error(`Unsupported image type ".${ext}" — use jpg/png/webp/gif.`);

  const form = new FormData();
  form.append('image', new Blob([buf], { type }), name);

  const res = await fetch(`${API_URL}/api/upload`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${API_KEY}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Upload failed (HTTP ${res.status})`);
  return json.url;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'keou_upload_image',
    description: 'Upload a local image file (jpg/png/webp/gif, max 20MB) to Keou storage. Returns a URL usable by all generate_* tools. Use this when the user references a file path on disk.',
    inputSchema: {
      type: 'object',
      required: ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Absolute local file path' },
      },
    },
  },
  {
    name: 'keou_generate_image',
    description: 'Generate one product image variant from a source image URL. Use the format param to pick a creative angle (e.g. "lifestyle", "studio", "social"). Returns a generationId — poll keou_get_status to retrieve the result.',
    inputSchema: {
      type: 'object',
      required: ['imgUrl'],
      properties: {
        imgUrl: { type: 'string', description: 'Source image URL (from keou_upload_image or any public URL)' },
        format: { type: 'string', description: 'Format preset key (optional, server-defined)' },
        creativeDirection: { type: 'string', description: 'Free-form creative brief (optional)' },
        projectId: { type: 'integer', description: 'Project to attach the result to (optional)' },
        campaignId: { type: 'integer', description: 'Campaign to attach the result to (optional)' },
      },
    },
  },
  {
    name: 'keou_generate_video',
    description: 'Generate a video from an image URL. Returns a generationId — poll keou_get_status with type="video".',
    inputSchema: {
      type: 'object',
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string' },
        creativeDirection: { type: 'string' },
        videoModel: { type: 'string' },
        duration: { type: 'integer' },
        resolution: { type: 'string' },
        aspectRatio: { type: 'string' },
        projectId: { type: 'integer' },
        campaignId: { type: 'integer' },
      },
    },
  },
  {
    name: 'keou_polish',
    description: 'Polish/retouch an existing image (cleanup, lighting, sharpening). Returns a new generationId.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl'],
      properties: {
        imageUrl: { type: 'string' },
        ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        projectId: { type: 'integer' },
      },
    },
  },
  {
    name: 'keou_remix',
    description: 'Remix an image with a custom prompt (re-imagine the scene). Returns a new generationId.',
    inputSchema: {
      type: 'object',
      required: ['imageUrl', 'remixPrompt'],
      properties: {
        imageUrl: { type: 'string' },
        remixPrompt: { type: 'string', description: 'Free-form prompt describing the remix' },
        ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
        projectId: { type: 'integer' },
      },
    },
  },
  {
    name: 'keou_list_packs',
    description: 'List the available export pack presets (each pack is a set of N format variants generated in parallel from one source image).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'keou_generate_pack',
    description: 'Fan out one completed source image into N format variants in parallel. Use this for "give me 30 visuals from this image" workflows. Requires a sourceGenerationId that is already completed (run keou_generate_image first, then keou_get_status until ready). Returns a packId — poll keou_get_pack_status.',
    inputSchema: {
      type: 'object',
      required: ['sourceGenerationId', 'packId'],
      properties: {
        sourceGenerationId: { type: 'integer', description: 'ID of a completed source generation' },
        packId: { type: 'string', description: 'Pack preset id from keou_list_packs' },
        projectId: { type: 'integer' },
        campaignId: { type: 'integer' },
      },
    },
  },
  {
    name: 'keou_get_status',
    description: 'Poll the status of a single generation. Returns { ready, state, resultUrl?, error? }. Use when generationId/taskId came from generate_image, generate_video, polish, remix.',
    inputSchema: {
      type: 'object',
      required: ['type', 'taskId'],
      properties: {
        type: { type: 'string', description: 'image | video | polish | remix | adapt' },
        taskId: { type: 'string' },
        generationId: { type: 'integer', description: 'Strongly recommended — enables DB fast path' },
        recordId: { type: 'string' },
      },
    },
  },
  {
    name: 'keou_get_pack_status',
    description: 'Poll the status of an export pack. Returns aggregate progress { total, ready, failed, done } plus per-item URLs as they complete.',
    inputSchema: {
      type: 'object',
      required: ['packId'],
      properties: { packId: { type: 'string' } },
    },
  },
  {
    name: 'keou_list_projects',
    description: 'List the user\'s projects (id, name, status). Use to resolve a project name into projectId before calling generate_*.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Tool dispatch ──────────────────────────────────────────────────────────

const HANDLERS = {
  keou_upload_image: async ({ filePath }) => ({ url: await uploadFile(filePath) }),

  keou_generate_image: (args) => api('POST', '/api/generate', args),
  keou_generate_video: (args) => api('POST', '/api/video', args),
  keou_polish: (args) => api('POST', '/api/polish', args),
  keou_remix: (args) => api('POST', '/api/remix', args),

  keou_list_packs: () => api('GET', '/api/packs'),
  keou_generate_pack: (args) => api('POST', '/api/pack', args),

  keou_get_status: ({ type, taskId, generationId, recordId }) => {
    const qs = new URLSearchParams();
    if (generationId) qs.set('generationId', String(generationId));
    if (recordId) qs.set('recordId', recordId);
    const q = qs.toString();
    return api('GET', `/api/status/${encodeURIComponent(type)}/${encodeURIComponent(taskId)}${q ? '?' + q : ''}`);
  },
  keou_get_pack_status: ({ packId }) => api('GET', `/api/pack/${encodeURIComponent(packId)}/status`),

  keou_list_projects: () => api('GET', '/api/projects'),
};

// ─── MCP wiring ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'keou-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await handler(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: e.message || 'Tool execution failed' }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[keou-mcp] connected — API ${API_URL}\n`);
