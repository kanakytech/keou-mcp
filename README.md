# keou-mcp

> **Design assistant for marketers and agencies. Generate ad creatives, brand assets, format-perfect variants — from any Claude chat.**

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-1.0-7b61ff)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/kanakytech/keou-mcp?label=release&color=22c55e)](https://github.com/kanakytech/keou-mcp/releases)

A Model Context Protocol server that turns Claude (Code, Desktop, Cursor) into a creative production assistant. Type *"give me 30 ad-ready variants of this product photo for the IG launch — square, story, reel, banners"* in chat. Claude orchestrates the workflow; KIE.AI / FAL.AI render the visuals; Keou packages the format pack for delivery.

```
You ──► Claude ──► keou-mcp ──► KIE.AI / FAL.AI ──► design-system-aware visual assets
```

> Built by the team behind [Keou Systems](https://keou.systems) — the B2B platform that turns one product photo into 30 ad-ready visuals in 20 minutes. The MCP gives you the **single-asset** and **format-pack** workflows; upgrade to [Keou Pro](https://keou.systems/pro) for brand kit auto-apply, persistent history, and team collaboration.

---

## What it does

| You ask | The MCP delivers |
|---|---|
| *"Generate a moody studio shot of this product, 1:1 premium"* | One on-brand image, ~$0.04 |
| *"Make 30 ad variants — IG square, story, reel, TikTok, banners"* | One source image fanned out into a format-perfect pack (Pro tier) |
| *"Remix this image with a sunset beach background"* | Image-to-image rework with prompt control |
| *"Upscale this to 4K for print"* | FAL clarity-upscaler 2x or 4x |
| *"Generate a 9:16 vertical video with a slow zoom"* | KIE.AI Veo 3.1 image-to-video |

10 tools. Smart routing. BYOK (Bring Your Own Key) — no Keou account needed for the basics.

---

## 60-second install

```bash
git clone https://github.com/kanakytech/keou-mcp.git
cd keou-mcp
npm install
```

Add to your Claude config:

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

**Or use the 1-click installer**: visit [keou.systems/install](https://keou.systems/install) — autodetects your Claude client and gives you the exact command to copy/paste.

Restart Claude. Run `/mcp` — you should see 10 `keou_*` tools. Done.

> **No key yet?** Skip the env block, restart Claude, and ask: *"Run keou_setup."* The MCP walks you through it.

---

## Get an API key (pick one)

| Provider | Best for | Cost | Free credits | Sign up |
|---|---|---|---|---|
| **KIE.AI** | Cheapest, fastest. Default. | ~$0.04/image (nano-banana) | Yes | [kie.ai](https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793) |
| **FAL.AI** | Premium quality (Flux Pro). | ~$0.10/image | Yes | [fal.ai](https://fal.ai) |
| **Keou Pro** *(optional)* | Pack of 30 variants, brand kit, history, team | $19/mo, 15 free | Yes | [keou.systems/pro](https://keou.systems/pro) |

You can configure both KIE and FAL — the MCP picks per-task: KIE for cost-sensitive renders, FAL for premium quality + upscaling, KIE.AI Veo3 for video.

---

## Tools reference

### Free tier (BYOK)

| Tool | What it does | Inputs |
|---|---|---|
| `keou_setup` | First-run wizard. Returns signup links + config instructions. | — |
| `keou_status_keys` | Show which keys are configured and what's unlocked. | — |
| `keou_generate_image` | Generate a creative asset from a brief (and optional source). | `prompt`, `aspectRatio?`, `quality?`, `provider?`, `sourceImageUrl?` |
| `keou_generate_video` | Short-form video from a brief + optional source (Veo 3.1). | `prompt`, `sourceImageUrl?`, `aspectRatio?`, `quality?` |
| `keou_remix_image` | Re-imagine an existing asset with new direction. | `imageUrl`, `prompt`, `aspectRatio?`, `provider?` |
| `keou_upscale_image` | Upscale a finished asset to print-ready resolution. | `imageUrl`, `scale?` |
| `keou_get_status` | Poll an in-flight render. | `taskId`, `provider`, `model?` |

### Premium (Keou Pro)

| Tool | What it does |
|---|---|
| `keou_pack_30_variants` | Fan a finished asset into 30 format-perfect variants in parallel — IG square, story, reel, TikTok, ad creative, banners. Saves ~25h of manual reformatting per pack. |
| `keou_pack_status` | Poll an export pack — aggregate progress + per-item URLs. |
| `keou_brand_kit_apply` | Auto-apply your brand colors, fonts, logo placement across all generations. *Coming v0.5.* |

> Premium tools without `KEOU_API_KEY` return a clean upgrade prompt with the signup URL — no silent failures.

---

## Example session

> **You:** *Generate a moody studio shot of a black coffee mug on dark slate, 1:1, premium quality.*

```
1. keou_generate_image (provider: kie, quality: pro)
   → { taskId: "tk_abc123", provider: "kie" }

2. keou_get_status (taskId: "tk_abc123", provider: "kie")
   → { ready: true, resultUrls: ["https://..."] }
```

Asset delivered in ~30s. ~$0.10 charged on your KIE account.

> **You:** *Now ship 30 ad variants of that for the IG launch.*

```
keou_pack_30_variants (sourceGenerationId: 412, packType: "ads")
→ { packId: "pk_x9k2f8", formats: [{ ratio, generationId, taskId }, ...30 items] }
keou_pack_status (packId: "pk_x9k2f8")
→ { total: 30, ready: 30, done: true, items: [...30 URLs] }
```

A complete IG launch pack — square, story, reel covers, banners, ad creatives — in 5 minutes.

---

## For agencies and creative teams

Keou Pro is the multiplier when single-asset workflows aren't enough:

- **Format packs** — one source image → 30 publish-ready variants
- **Brand kit auto-apply** — colors, fonts, logo placement enforced server-side
- **Persistent history** — every asset saved, taggable, fork-able
- **Team workspaces** — share an API key, track per-seat usage
- **White-label option** — agencies can deploy Keou under their own brand for clients (Agency tier, $499/mo)

[Start Pro — $19/mo, 15 free generations](https://keou.systems/pro)

---

## Configuration alternatives

Don't want keys in `.mcp.json`? Save them to `~/.keou-mcp/config.json` instead:

```json
{
  "kieKey": "...",
  "falKey": "...",
  "keouKey": "..."
}
```

The MCP reads env vars first, then this file. File is created with mode `0600` (owner-only).

---

## Security model

- **Provider keys are bearer tokens.** Anyone with the plaintext can spend on your account. Don't commit `.mcp.json`.
- **One key per device.** Most providers let you label keys — name them "claude-code-laptop", "claude-desktop-home".
- **No telemetry.** This MCP makes exactly the API calls you ask for, nothing else. Audit `server.js` (~370 lines) yourself.

---

## Roadmap

- [x] **v0.2** — Standalone BYOK (KIE + FAL), onboarding flow
- [x] **v0.2.1** — Veo3 dedicated endpoint, model ID corrections
- [x] **v0.3** — KIE.AI affiliate integration
- [x] **v0.4** — Real `keou_pack_30_variants` + `keou_pack_status` calling Keou agency
- [ ] **v0.5** — `keou_brand_kit_apply` (auto-apply brand system)
- [ ] **v0.6** — Replicate provider support, Stable Diffusion 3.5
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
