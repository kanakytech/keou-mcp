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

## 1-click install (recommended)

Visit **[keou.systems/install](https://keou.systems/install)** and click "Add to Claude". That's it.

What happens:
1. Claude Code opens with a pre-typed install prompt
2. You press Enter
3. Claude installs the MCP, asks you for your KIE.AI key, configures it, and runs a first test

You don't run any commands yourself. You just paste your KIE.AI key when Claude asks. ~60 seconds total, zero technical knowledge needed.

**Don't have Claude Code?** Same page lets you copy the install prompt into Claude Desktop or claude.ai instead.

---

## Manual install (if you prefer the CLI directly)

```bash
claude mcp add keou --scope user -e KIE_API_KEY=your-key-here -- npx -y github:kanakytech/keou-mcp
```

> The API key must be passed at install time via `-e` — `claude mcp env set` does not exist as a command. To change the key later, remove and re-add: `claude mcp remove keou -s user && claude mcp add keou --scope user -e KIE_API_KEY=new-key -- npx -y github:kanakytech/keou-mcp`.

Verify with `claude mcp get keou` — should show `Status: ✓ Connected`.

Restart Claude Code. Run `/mcp` — you should see 10 `keou_*` tools.

For Claude Desktop, paste this into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "keou": {
      "command": "npx",
      "args": ["-y", "github:kanakytech/keou-mcp"],
      "env": { "KIE_API_KEY": "your-key-here" }
    }
  }
}
```

> **No key yet?** Once installed, ask Claude: *"Run keou_setup."* — the MCP walks you through getting one.

---

## Get an API key (pick one)

| Provider | Best for | Cost | Free credits | Sign up |
|---|---|---|---|---|
| **KIE.AI** | Powers everything (image, video, audio, upscale). | $0.09/img, $0.25/s video, $0.05 audio | Yes | [kie.ai](https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793) |
| **FAL.AI** | Premium quality (Flux Pro). | ~$0.10/image | Yes | [fal.ai](https://fal.ai) |
| **Keou Pro** *(optional)* | Pack of 30 variants, brand kit, history, team | $19/mo, 15 free | Yes | [keou.systems/pro](https://keou.systems/pro) |

You can configure both KIE and FAL — the MCP picks per-task: KIE for cost-sensitive renders, FAL for premium quality + upscaling, KIE.AI Veo3 for video.

---

## Tools reference

### Free tier (BYOK)

Tools below use Keou's production model stack — same models the paid SaaS uses internally:
- Image gen / adapt: `nano-banana-pro` (Gemini 3 Pro Image)
- Polish / remix: `flux-2/pro-image-to-image`
- Video: KIE.AI Veo 3.1 (`veo3_fast` default, `veo3` pro)
- Image / video upscale: `topaz/image-upscale` and `topaz/video-upscale`
- Voice-over: ElevenLabs Turbo v2.5
- Sound effects: ElevenLabs Sound Effects v2

All routed through the user's single `KIE_API_KEY` — no FAL.AI key needed.

| Tool | What it does | Inputs |
|---|---|---|
| `keou_setup` | First-run wizard. Returns signup links + config instructions. | — |
| `keou_welcome` | Structured guide — example prompts, key concepts, costs, pro tips. Called by the install prompt after the first test image. | — |
| `keou_status_keys` | Show which keys are configured and what's unlocked. | — |
| `keou_generate_image` | Text-to-image, or image-to-image with `sourceImageUrl`. `nano-banana-pro`, 2K default. | `prompt`, `sourceImageUrl?`, `aspectRatio?`, `resolution?` (`2K`/`4K`) |
| `keou_polish_image` | Clean up imperfections, enhance lighting, sharpen detail. Preserves composition. | `imageUrl`, `aspectRatio?`, `resolution?` |
| `keou_remix_image` | Re-imagine an existing image with a custom prompt (creative direction). | `imageUrl`, `prompt`, `aspectRatio?`, `resolution?` |
| `keou_adapt_image` | Re-render in a new aspect ratio (1:1 → 9:16 for stories, etc). | `imageUrl`, `aspectRatio`, `resolution?` |
| `keou_generate_video` | Short video from prompt + optional source. Veo 3.1 (`fast` or `pro`). | `prompt`, `sourceImageUrl?`, `aspectRatio?`, `quality?` |
| `keou_upscale_image` | Upscale 2x or 4x via Topaz on KIE. | `imageUrl`, `scale?` |
| `keou_upscale_video` | Upscale a video to 4K via Topaz on KIE. | `videoUrl`, `scale?` |
| `keou_text_to_speech` | Voice-over from text via ElevenLabs Turbo v2.5. Default voice "Rachel". | `text`, `voice?`, `stability?`, `similarityBoost?`, `style?`, `speed?` |
| `keou_generate_sfx` | Short sound effect from a text description (ElevenLabs SFX v2). | `text`, `durationSeconds?` |
| `keou_get_status` | Poll a generation. Pass back `taskId` + `provider` from submit. Inlines image/audio results directly in chat when ready. | `taskId`, `provider` (`kie`/`kie-veo`/`fal`), `model?` (FAL only) |

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
