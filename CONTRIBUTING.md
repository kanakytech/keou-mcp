# Contributing to keou-mcp

Thanks for your interest. This is an active open-source project — bug reports,
feature requests, and pull requests are all welcome.

## Quick links

- **Found a bug?** [Open an issue](https://github.com/kanakytech/keou-mcp/issues/new?template=bug_report.md)
- **Want a feature?** [Open a feature request](https://github.com/kanakytech/keou-mcp/issues/new?template=feature_request.md)
- **Want to add a provider?** Read [Adding a new provider](#adding-a-new-provider) below

## Development setup

```bash
git clone https://github.com/kanakytech/keou-mcp.git
cd keou-mcp
npm install
```

Run a smoke test:

```bash
KIE_API_KEY=your-key node server.js < /dev/null &
# stderr will print "[keou-mcp v0.x.x] connected — providers: KIE"
```

Test against your Claude client by adding to `.mcp.json`:

```json
{
  "mcpServers": {
    "keou-dev": {
      "command": "node",
      "args": ["/absolute/path/to/your/clone/server.js"],
      "env": { "KIE_API_KEY": "..." }
    }
  }
}
```

## Code style

- Single file (`server.js`) — keep it that way unless you have a strong reason
- ESM imports, modern Node 18+ (no transpilation, no build)
- 2-space indent, single quotes, semicolons
- Comment **why**, not what — well-named identifiers handle the what

## Adding a new provider

1. Add a `<provider>Submit` and `<provider>Status` async pair following the
   existing `kieSubmit` / `falSubmit` shape
2. Update `pickProvider()` if it should be auto-selected
3. Update `KIE_DEFAULTS` / `FAL_DEFAULTS` style constants for default models
4. Add a config field (`<provider>Key`) in `loadConfig()`
5. Add tools or extend existing ones to expose the provider
6. Update `keou_setup` and `keou_status_keys` to surface the new option
7. Update the README "Get an API key" table
8. Add a CHANGELOG entry

## Pull request guidelines

- Branch off `main` with a descriptive name (`feat/replicate-provider`,
  `fix/veo3-callback-url`)
- One topic per PR — easier to review, easier to revert
- Update CHANGELOG.md under `## [Unreleased]` (we'll bump the version on merge)
- If you change tool schemas, run a smoke test against a real Claude client
  and confirm the tools still appear in `/mcp`

## Affiliate / referral disclaimer

The default signup URLs in `server.js` include the maintainer's affiliate
referral codes (KIE.AI, FAL.AI). This funds ongoing development. Forks and
self-hosted deployments can override via env vars (`KIE_SIGNUP_URL` etc.) —
contributors are explicitly free to keep their own referral revenue when
running their own deployments.

## License

By contributing, you agree your contributions will be licensed under MIT.
