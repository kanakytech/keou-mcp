# keou-mcp

> The fastest way to generate product visuals from Claude chat. Bring your own API key.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.0-7b61ff)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

Plug-and-play MCP server connecting Claude Code / Claude Desktop to **KIE.AI** and **FAL.AI**. Type *"generate a studio shot of this product, 9:16, premium quality"* in chat and get a finished image. **No middleman.** You pay providers directly at cost (~$0.04/image).

> Built by the team behind [Keou](https://keou.systems) — the B2B platform that turns one product photo into 30 ad-ready visuals in 20 minutes. The MCP gives you the **single-image** workflow for free; upgrade to [Keou Pro](https://keou.systems/pro) when you need to scale.

---

## Why this exists

Image-gen APIs are powerful but the auth, polling, formatting, and retry logic are a pain to re-implement every time. This MCP gives Claude a clean, opinionated wrapper that just works:

- **6 free tools** wrapping KIE.AI + FAL.AI (BYOK)
- **2 premium tools** (`pack_30_variants`, `brand_kit_apply`) for users who upgrade to Keou Pro
- **Smart routing** — uses the cheapest viable model by default, lets you override
- **Onboarding-first** — first run shows you exactly where to get a key

---

## 60-second install

```bash
git clone https://github.com/kanakytech/keou-mcp.git
cd keou-mcp
npm install
```

Add to your Claude config (`.mcp.json` for Claude Code at project root, or `~/Library/Application Support/Claude/claude_desktop_config.json` for Desktop):

```json
{
  "mcpServers": {
    "keou": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/keou-mcp/server.js"],
      "env": {
        "KIE_API_KEY": "your-kie-key-here"
      }
    }
  }
}
```

Restart Claude. Run `/mcp` to see the 9 tools. Done.

**Don't have a key yet?** Skip the env block, restart Claude, and ask: *"Run keou_setup."* The MCP will walk you through it.

---

## Get an API key (pick one)

| Provider | Best for | Cost | Free credits | Sign up |
|---|---|---|---|---|
| **KIE.AI** | Cheapest, fastest. Default. | ~$0.04/image (nano-banana) | Yes | [kie.ai](https://kie.ai) |
| **FAL.AI** | Premium quality (Flux Pro). | ~$0.10/image | Yes | [fal.ai](https://fal.ai) |
| **Keou Pro** *(optional)* | Batch packs (30 variants), brand kit, history | $19/mo, 15 free generations | Yes | [keou.systems/pro](https://keou.systems/pro) |

You can configure both KIE and FAL — the MCP picks per-task: KIE for cheap images, FAL for premium quality, video via KIE.

---

## Tools reference

### Free tier (BYOK)

| Tool | What it does | Inputs |
|---|---|---|
| `keou_setup` | First-run wizard. Returns signup links + config instructions. | — |
| `keou_status_keys` | Show which keys are configured and what's unlocked. | — |
| `keou_generate_image` | Text-to-image (or image-to-image with `sourceImageUrl`). | `prompt`, `aspectRatio?`, `quality?`, `provider?`, `sourceImageUrl?` |
| `keou_generate_video` | Short video from prompt + optional source image. KIE.AI only. | `prompt`, `sourceImageUrl?`, `aspectRatio?`, `duration?` |
| `keou_remix_image` | Re-imagine an existing image with a new prompt. | `imageUrl`, `prompt`, `aspectRatio?`, `provider?` |
| `keou_upscale_image` | Upscale 2x or 4x (FAL clarity-upscaler preferred). | `imageUrl`, `scale?` |
| `keou_get_status` | Poll a generation. Pass back `taskId` + `provider` from submit. | `taskId`, `provider`, `model?` (FAL only) |

### Premium (Keou Pro)

| Tool | What it does |
|---|---|
| `keou_pack_30_variants` | Fan one source image into 30 format-perfect variants in parallel (Instagram square, story, reel, TikTok, ad, banners). Saves ~25h/pack. |
| `keou_brand_kit_apply` | Auto-apply your brand colors, fonts, logo placement across all generations. |

> Calling these without `KEOU_API_KEY` returns an upgrade prompt with the signup URL. No silent failures.

---

## Example chat

> **You:** Generate a moody studio shot of a black coffee mug on a dark slate background, 1:1, premium quality.

```
1. keou_generate_image (provider: kie, quality: pro)
   → { taskId: "tk_abc123", provider: "kie", model: "google/nano-banana-pro" }
2. keou_get_status (taskId: "tk_abc123", provider: "kie")
   → { ready: false, state: "generating" }   (30s later)
   → { ready: true, resultUrls: ["https://..."] }
```

Claude pastes the URL, you save the image. ~$0.10 charged on your KIE account.

> **You:** Now give me 30 variants of that for my IG launch.

```
keou_pack_30_variants (...)
→ { locked: true, upgradeUrl: "https://keou.systems/pro", pricing: "$19/mo, 15 free to start" }
```

You get a clear nudge to upgrade — or stay free and use `keou_generate_image` 30 times manually.

---

## Configuration alternatives

Don't want to keep keys in `.mcp.json`? Save them to `~/.keou-mcp/config.json` instead:

```json
{
  "kieKey": "...",
  "falKey": "...",
  "keouKey": "..."
}
```

The MCP reads env vars first, then this file. File is created with mode `0600` (owner read/write only).

---

## Local Keou agency dev

If you're running the Keou agency locally and want the premium tools to point there:

```json
"env": {
  "KEOU_API_URL": "http://localhost:3000",
  "KEOU_API_KEY": "keou_..."
}
```

---

## Security model

- **Provider keys are bearer tokens.** Anyone with the plaintext can spend on your account. Don't commit `.mcp.json`.
- **One key per device.** Most providers let you label keys — name them "claude-code-laptop", "claude-desktop-home", etc.
- **No telemetry.** This MCP makes exactly the API calls you ask for, nothing else. Audit `server.js` (~340 lines) yourself.

---

## Roadmap

- [x] **v0.2** — Standalone BYOK (KIE + FAL), onboarding flow, premium funnel stubs
- [ ] **v0.3** — Local image upload (R2/S3 helper for premium users)
- [ ] **v0.4** — Real `keou_pack_30_variants` calling Keou agency
- [ ] **v0.5** — `keou_brand_kit_apply` real implementation
- [ ] **v1.0** — Published on npm: `npx keou-mcp` direct in Claude config

Issues / PRs welcome.

---

## Contributors

- [@kanakytech](https://github.com/kanakytech/) — author
- [linkedin.com/in/kevyn-wahuzue](https://linkedin.com/in/kevyn-wahuzue)

Co-authored with PAI-2.

## License

MIT — see [LICENSE](LICENSE).
