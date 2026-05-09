# The magic install prompt

This is the canonical install prompt. The "Add to Claude" button on the
landing pages embeds this exact text (URL-encoded) into a `claude-cli://`
deep link. Clicking the button opens Claude Code with the prompt already
typed — the user just presses Enter and Claude does everything.

Keep this file under ~3500 chars (URL-encoded grows ~3x to ~10500, well
under the 5000-char encoded limit when accounting for typical prompts —
verified at the bottom).

---

## Prompt

```
I want to install Keou MCP — an open-source tool that lets me generate product images and videos directly from this Claude chat. Please walk me through it step by step, I'm not technical.

Step 1 — Install the MCP:
Run this command:
claude mcp add keou --scope user -- npx -y github:kanakytech/keou-mcp

Step 2 — Get me an API key:
I need a KIE.AI key to generate images (~$0.04 per image, free credits on signup). If I don't already have one, send me to https://kie.ai?ref=ec0e98ef53c18d6f13f05629a9ffd793 and tell me to:
- Sign up (free)
- Open Settings → API Key
- Copy the key (starts with letters/numbers)
- Paste it back here

Step 3 — Configure the key:
Once I paste my key, run:
claude mcp env set keou KIE_API_KEY=<the-key-I-pasted>

Step 4 — Restart:
Tell me to close this Claude Code session and open a fresh one so the MCP loads with my key. (Just exit and run claude again.)

Step 5 — First test:
After I'm back, suggest a fun first test like:
"Generate a moody studio shot of a black coffee mug on dark slate, 1:1, premium quality"

Then call the keou_generate_image tool with that prompt and poll keou_get_status until ready, then show me the URL.

Important:
- Be friendly and patient, I might be new to coding
- Explain WHAT each step does in one sentence before running it
- If a command fails, debug it for me — don't just dump errors
- Don't go off-script: only do these 5 steps
```

---

## Length check

The prompt above is ~1450 chars raw. URL-encoded with `encodeURIComponent`
it grows to roughly 1900 chars — comfortably under the 5000-char limit
documented at https://code.claude.com/docs/en/deep-links.

## How to test the deep link

```bash
# macOS — opens Claude Code with the prompt pre-typed
open "claude-cli://open?q=$(node -e 'console.log(encodeURIComponent(require("fs").readFileSync("INSTALL_PROMPT.md","utf8").split("```")[1].trim()))')"
```
