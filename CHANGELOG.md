# Changelog

All notable changes to keou-mcp documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-05-09

### Added
- Real implementation of `keou_pack_30_variants` — calls Keou agency
  `/api/pack` endpoint, fans a completed source generation into N format
  variants in parallel.
- New tool `keou_pack_status` — polls pack progress (total / ready / failed
  / done) plus per-item URLs.

### Changed
- `keou_brand_kit_apply` returns a clean "coming soon (v0.5)" response with
  workaround guidance instead of a TODO stub.

## [0.3.0] — 2026-05-09

### Added
- Affiliate referral integration with KIE.AI (15% commission on first 30 days
  of referred users' usage). Default `SIGNUP_KIE` URL now embeds the maintainer's
  referral code.
- `KIE_SIGNUP_URL` / `FAL_SIGNUP_URL` / `KEOU_SIGNUP_URL` env overrides — forks
  can plug their own referral codes without editing source.

## [0.2.1] — 2026-05-08

### Fixed
- KIE.AI Veo3 video generation moves to its dedicated endpoint family
  (`/api/v1/veo/generate` for submit, `/api/v1/veo/record-info` for status).
  Previous version incorrectly routed video through `/jobs/createTask`.
- Veo3 model IDs corrected: `veo3_fast` (default), `veo3` (Quality).
- Status flag mapping for Veo3 (1=success, 2/3=failed) — distinct from
  the main task queue's `state` strings.
- `keou_get_status` now accepts `provider: "kie-veo"`.

### Removed
- Nonexistent `kie/upscale` model fallback. `keou_upscale_image` is now
  FAL.AI–only (`fal-ai/clarity-upscaler`).

## [0.2.0] — 2026-05-08

### Changed (BREAKING)
- Pivoted to standalone BYOK (Bring Your Own Key) architecture. The MCP no
  longer requires a Keou agency account for the free tier — users connect
  KIE.AI and/or FAL.AI directly with their own API keys.
- `KEOU_API_KEY` is now optional and only unlocks premium tools.

### Added
- `keou_setup` first-run wizard (returns signup links + config instructions).
- `keou_status_keys` shows which providers are configured.
- Premium tool stubs `keou_pack_30_variants` and `keou_brand_kit_apply` —
  return upgrade prompts when no Keou Pro key is set.
- Smart provider routing: prefers KIE.AI for cost, FAL.AI for quality.
- Config fallback: env vars first, then `~/.keou-mcp/config.json` (mode 0600).

## [0.1.0] — 2026-05-08

### Added
- Initial release. 10 tools wrapping the Keou agency API via long-lived
  `keou_*` API keys. Required a Keou agency account (deprecated in v0.2).
