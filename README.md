# keou-mcp

> **Generate images and videos from any Claude chat. Bring your own API key.**

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.0-7b61ff)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/kanakytech/keou-mcp?label=release&color=22c55e)](https://github.com/kanakytech/keou-mcp/releases)

Plug-and-play Model Context Protocol server connecting Claude Code and Claude Desktop to **KIE.AI** and **FAL.AI**. Type *"generate a moody studio shot of this product, 9:16, premium quality"* in chat and get a finished image. **No middleman.** You pay providers directly at cost — generations start at ~$0.04.

```
You → Claude → keou-mcp → KIE.AI / FAL.AI → image URL
```

> Built by the team behind [Keou Systems](https://keou.systems) — the B2B platform that turns one product photo into 30 ad-ready visuals in 20 minutes. The MCP gives you the **single-image** workflow free; upgrade to [Keou Pro](https://keou.systems/pro) when you need to scale.

---

## Why this exists

Image-gen APIs are powerful, but the auth, polling, format mapping, and retry logic are a pain to glue together. This MCP gives Claude a clean, opinionated wrapper that just works:

- **6 free tools** wrapping KIE.AI + FAL.AI (BYOK — no Keou account needed)
- **2 premium tools** (`pack_30_variants`, `brand_kit_apply`) for users who scale up to Keou Pro
- **Smart routing** — picks the cheapest viable model by default, lets you override
- **Onboarding-first** — first run shows you exactly where to get a key and how to plug it in

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

Restart Claude. Run `/mcp` — you should see 9 `keou_*` tools. Done.

> **Don't have a key yet?** Skip the env block, restart Claude, and ask: *"Run keou_setup."* The MCP walks you through it.

---

## Get an API key (pick one)

| Provider | Best for | Cost | Free credits | Sign up |
|---|---|---|---|---|
| **KIE.AI** | Cheapest, fastest. Default. | ~$0.04/image (nano-banana) | Yes | [kie.ai](https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793) |
| **FAL.AI** | Premium quality (Flux models). | ~$0.10/image | Yes | [fal.ai](https://fal.ai) |
| **Keou Pro** *(optional)* | Batch packs (30 variants), brand kit, history | $19/mo, 15 free generations | Yes | [keou.systems/pro](https://keou.systems/pro) |

You can configure both KIE and FAL — the MCP picks per-task: KIE for cheap images, FAL for premium quality + upscaling, KIE.AI Veo3 for video.

---

## Tools reference

### Free tier (BYOK)

| Tool | What it does | Inputs |
|---|---|---|
| `keou_setup` | First-run wizard. Returns signup links + config instructions. | — |
| `keou_status_keys` | Show which keys are configured and what's unlocked. | — |
| `keou_generate_image` | Text-to-image (or image-to-image with `sourceImageUrl`). | `prompt`, `aspectRatio?`, `quality?`, `provider?`, `sourceImageUrl?` |
| `keou_generate_video` | Short video from prompt + optional source image (Veo 3.1). | `prompt`, `sourceImageUrl?`, `aspectRatio?`, `quality?` |
| `keou_remix_image` | Re-imagine an existing image with a new prompt. | `imageUrl`, `prompt`, `aspectRatio?`, `provider?` |
| `keou_upscale_image` | Upscale 2x or 4x (FAL clarity-upscaler). | `imageUrl`, `scale?` |
| `keou_get_status` | Poll a generation. Pass back `taskId` + `provider` from submit. | `taskId`, `provider`, `model?` (FAL only) |

### Premium (Keou Pro)

| Tool | What it does |
|---|---|
| `keou_pack_30_variants` | Fan one source image into 30 format-perfect variants in parallel (Instagram square, story, reel, TikTok, ad creative, banners). Saves ~25h/pack. |
| `keou_brand_kit_apply` | Auto-apply your brand colors, fonts, logo placement, and style across generations. |

> Calling these without `KEOU_API_KEY` returns an upgrade prompt with the signup URL. No silent failures.

---

## Example chat

> **You:** *Generate a moody studio shot of a black coffee mug on dark slate, 1:1, premium quality.*

```
1. keou_generate_image (provider: kie, quality: pro)
   → { taskId: "tk_abc123", provider: "kie", model: "google/nano-banana-pro" }

2. keou_get_status (taskId: "tk_abc123", provider: "kie")
   → { ready: false, state: "generating" }   (~30s later)
   → { ready: true, resultUrls: ["https://..."] }
```

Claude pastes the URL. ~$0.10 charged on your KIE account.

> **You:** *Now give me 30 variants of that for my IG launch.*

```
keou_pack_30_variants (...)
→ { locked: true, upgradeUrl: "https://keou.systems/pro", pricing: "$19/mo, 15 free to start" }
```

You get a clear nudge to upgrade — or stay free and call `keou_generate_image` 30 times manually.

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
- **No telemetry.** This MCP makes exactly the API calls you ask for, nothing else. Audit `server.js` (~370 lines) yourself.

---

## Roadmap

- [x] **v0.2** — Standalone BYOK (KIE + FAL), onboarding flow, premium funnel stubs
- [x] **v0.2.1** — Veo3 dedicated endpoint, model ID corrections
- [x] **v0.3** — KIE.AI affiliate integration, env-overridable signup URLs
- [ ] **v0.4** — Real `keou_pack_30_variants` calling Keou agency
- [ ] **v0.5** — `keou_brand_kit_apply` real implementation
- [ ] **v1.0** — Published on npm: `npx keou-mcp` direct in Claude config

[Issues / PRs welcome](CONTRIBUTING.md).

---

## Sustainability disclosure

The default `SIGNUP_KIE` URL embeds the maintainer's KIE.AI affiliate referral code. KIE pays a 15% commission on referred users' first 30 days of API spend — that's how this project funds itself. Forks and self-hosted deployments can plug their own referral codes via env vars (`KIE_SIGNUP_URL`) without editing source. See [CONTRIBUTING.md](CONTRIBUTING.md#affiliate--referral-disclaimer).

---

## Contributors

- [@kanakytech](https://github.com/kanakytech/) — author
- [linkedin.com/in/kevyn-wahuzue](https://linkedin.com/in/kevyn-wahuzue)

Co-authored with PAI-2.

## License

MIT — see [LICENSE](LICENSE).
