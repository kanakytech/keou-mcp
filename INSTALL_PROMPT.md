# The magic install prompt

This is the canonical install prompt. The `Add to Claude` button on the
landing pages displays this prompt to the user with a Copy button — they
paste it into Claude (Code, Desktop, or claude.ai), Claude reads it and
walks them through the install.

`atc.js` (in keou-agency/public/ and keou-site/) is the source of truth
for the runtime prompt. Edit that file when changing wording — this
markdown is the human-readable mirror.

---

## Why the order matters

Claude Code does NOT have a `claude mcp env set` command (despite earlier
versions of this guide claiming otherwise). The only way to set an env
var on a stdio MCP is to pass it at install time via `-e KEY=VALUE` in
`claude mcp add`. So the user's API key must be collected BEFORE we run
the install command. Anything else triggers `error: unknown command 'env'`.

---

## Prompt

```
I want to install Keou MCP — an open-source tool that lets me generate product images and videos directly from this Claude chat. Please walk me through it step by step, I'm not technical.

Step 1 — Get my KIE.AI key first (the install needs it):
I need a KIE.AI key to generate images (~$0.04 per image, free credits on signup). Ask me if I have one already.
- If yes: ask me to paste it in this chat now.
- If no: send me to https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793, tell me to sign up (free), open Settings → API Key, copy the key, then paste it back here.
Wait until I've actually pasted the key before moving on.

Step 2 — Install the MCP with my key in one command:
Once I've pasted my key, run this exact command (replace <KEY> with what I pasted):
claude mcp add keou --scope user -e KIE_API_KEY=<KEY> -- npx -y github:kanakytech/keou-mcp

If I had Keou installed before without a key (or with a wrong key), use this instead — it removes the old install first:
claude mcp remove keou -s user && claude mcp add keou --scope user -e KIE_API_KEY=<KEY> -- npx -y github:kanakytech/keou-mcp

Step 3 — Verify:
Run:
claude mcp get keou
It should show "Status: ✓ Connected" and my key listed under Environment. If it says Failed or the env is empty, something went wrong — debug with me.

Step 4 — Restart:
Tell me to type /exit then run "claude" again. The MCP only loads on a fresh session.

Step 5 — First test:
After I'm back, suggest a fun first test like:
"Generate a moody studio shot of a black coffee mug on dark slate, 1:1, 2K resolution"
Call keou_generate_image with that prompt, poll keou_get_status until ready, then show me the URL.

Step 6 — Welcome guide:
Once the test image is ready and I've seen it, call keou_welcome. It returns a structured guide with example prompts and key concepts. Don't dump the whole thing — pick ONE example that matches what I'd want to do next (ask if unclear) and offer to run it with me.

Important:
- Be friendly and patient, I might be new to coding
- Explain WHAT each step does in one sentence before running it
- If a command fails, debug it for me — don't dump raw errors
- The "claude mcp env set" command does NOT exist. Don't try it. Use -e at install time.
- After step 6, follow my lead
```

---

## Length check

Last verified: 2257 chars raw, 3335 URL-encoded — under the 5000-char
deeplink limit (used by the optional `claude-cli://open?q=...` button
variant). Plenty of headroom for future tweaks.
