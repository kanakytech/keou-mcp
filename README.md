# keou-mcp

> MCP server for [Keou](https://keou.systems) — generate product visuals from any Claude chat.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.0-7b61ff)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

Plug-and-play bridge between Claude (Code, Desktop, any MCP client) and the Keou Agency API. You write *"upload this product shot and give me 30 lifestyle variants"* in chat — the MCP handles upload, generation, polling, and pack assembly.

---

## What it does

| You say | The MCP runs |
|---|---|
| *"Upload `~/Desktop/shoe.jpg`"* | `keou_upload_image` → R2 URL |
| *"Generate a studio shot from this URL"* | `keou_generate_image` → poll until ready |
| *"Make 30 lifestyle variants"* | `keou_generate_pack` → fan-out → ZIP |
| *"Polish this image"* | `keou_polish` |
| *"Remix it as a sunset beach scene"* | `keou_remix` |
| *"What projects do I have?"* | `keou_list_projects` |

10 tools. Stdio transport. One API key per user. No state on the MCP itself — everything goes through your Keou account.

---

## Quick start

### 1. Install

```bash
git clone https://github.com/kanakytech/keou-mcp.git
cd keou-mcp
npm install
```

### 2. Get an API key

Sign in to your Keou agency, open a terminal with your session token (DevTools → Network → any auth header), then:

```bash
curl -X POST https://your-agency.keou.systems/api/keys \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"label":"claude-code-laptop"}'
```

Response (the `key` field is shown **once** — copy it):

```json
{
  "id": 1,
  "key": "keou_xK3aF92bC1d4...",
  "prefix": "keou_xK3aF92b",
  "label": "claude-code-laptop",
  "createdAt": "2026-05-08T22:43:00Z"
}
```

### 3. Wire it to Claude

#### Claude Code

Add to `.mcp.json` at your project root (or `~/.config/claude-code/mcp.json` for global):

```json
{
  "mcpServers": {
    "keou": {
      "command": "node",
      "args": ["/absolute/path/to/keou-mcp/server.js"],
      "env": {
        "KEOU_API_URL": "https://your-agency.keou.systems",
        "KEOU_API_KEY": "keou_xK3aF92bC1d4..."
      }
    }
  }
}
```

Restart Claude Code, run `/mcp` — you should see 10 `keou_*` tools.

#### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Same `mcpServers` block. Restart the app.

---

## Tools reference

| Tool | Inputs | Returns |
|---|---|---|
| `keou_upload_image` | `filePath` (abs path, jpg/png/webp/gif, ≤20MB) | `{ url }` |
| `keou_generate_image` | `imgUrl`, `format?`, `creativeDirection?`, `projectId?`, `campaignId?` | `{ generationId, taskId, recordId, type }` |
| `keou_generate_video` | `imageUrl`, `videoModel?`, `duration?`, `resolution?`, `aspectRatio?`, `creativeDirection?`, `projectId?` | `{ generationId, taskId, recordId, type }` |
| `keou_polish` | `imageUrl`, `ratio?` (`1:1` `3:4` `4:3` `9:16` `16:9`) | `{ generationId, taskId, ... }` |
| `keou_remix` | `imageUrl`, `remixPrompt`, `ratio?` | `{ generationId, taskId, ... }` |
| `keou_list_packs` | — | `{ packs: [{ id, name, formats }] }` |
| `keou_generate_pack` | `sourceGenerationId` (must be completed), `packId`, `projectId?` | `{ packId, formats: [{ name, ratio, generationId }] }` |
| `keou_get_status` | `type`, `taskId`, `generationId?`, `recordId?` | `{ ready, state, resultUrl?, error? }` |
| `keou_get_pack_status` | `packId` | `{ total, ready, failed, done, items[] }` |
| `keou_list_projects` | — | `{ projects: [{ id, name, status }] }` |

---

## Example chat sessions

### Single visual

> **You:** Upload `/Users/me/shots/sneaker.jpg` and give me a clean studio version.

The MCP runs:
```
1. keou_upload_image  → https://r2.../uploads/...sneaker.png
2. keou_generate_image (format: "studio")  → generationId 412
3. keou_get_status (loop, ~30s)  → resultUrl
```

### 30-format pack

> **You:** Take that last result and fan it out into a lifestyle pack for project 12.

```
1. keou_list_packs  → finds pack id "lifestyle-30"
2. keou_generate_pack (sourceGenerationId: 412, packId: "lifestyle-30", projectId: 12)
3. keou_get_pack_status (loop)  → 30 URLs ready
```

### Video from product shot

> **You:** Make a 5-second 9:16 vertical video from URL X with a slow zoom.

```
1. keou_generate_video (imageUrl: X, duration: 5, aspectRatio: "9:16",
                         creativeDirection: "slow zoom in")
2. keou_get_status (type: "video", ...)
```

---

## API key management

| Action | Request |
|---|---|
| Create | `POST /api/keys` with `{ "label": "..." }` (max 10 keys/user) |
| List | `GET /api/keys` (returns prefix + label, never plaintext) |
| Revoke | `DELETE /api/keys/:id` |

Keys are stored as SHA-256 hashes. Plaintext is shown **once** at creation. Lost a key? Revoke it and create a new one.

`last_used_at` updates on every successful call — handy for spotting unused keys.

---

## Local development

Point the MCP at a local agency instance:

```json
"env": {
  "KEOU_API_URL": "http://localhost:3000",
  "KEOU_API_KEY": "keou_..."
}
```

Run the agency locally, create an API key against `localhost:3000/api/keys`, plug it in. The MCP will pipe everything to your dev server.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `KEOU_API_KEY missing` on boot | Add the env block to your `mcp.json`, restart the client |
| `Invalid API key` (401) | Wrong key, revoked, or pointing at the wrong `KEOU_API_URL` |
| Tools don't show up in Claude | Run `/mcp` to inspect — check the absolute path to `server.js` is correct |
| `HTTP 429` after batch | Rate limit; wait a minute, batch jobs share the `/api/*` 600 req/min bucket |
| `imgUrl required` (400) | The MCP forwards your inputs as-is — check the source URL is reachable |

Logs land on stderr. Run the server manually to debug:

```bash
KEOU_API_URL=... KEOU_API_KEY=keou_... node server.js
```

---

## Security model

- API key is a **bearer token** — anyone with the plaintext can call your agency on your behalf
- Keep it out of shell history, dotfiles in git, screenshots
- Each MCP install should have its **own key** (one per device, label them)
- Quotas (image / video credits) are enforced server-side per user — the MCP can't bypass them

---

## Repo layout

```
keou-mcp/
├── server.js              MCP server (stdio)
├── package.json
├── .mcp.json.example      drop-in config
└── README.md
```

No build step. No bundler. Just Node.

---

## Contributors

- [@kanakytech](https://github.com/kanakytech/) — author
- [linkedin.com/in/kevyn-wahuzue](https://linkedin.com/in/kevyn-wahuzue)

Co-authored with PAI-2.

## License

MIT — see [LICENSE](LICENSE).
