# The magic install prompt

This is the canonical install prompt. The `Add to Claude` button on the
landing pages displays this prompt to the user with a Copy button — they
paste it into Claude (Code, Desktop, or claude.ai), Claude reads it and
walks them through the install.

`atc.js` (in keou-agency/public/ and keou-site/) is the source of truth
for the runtime prompt. Edit that file when changing wording — this
markdown is the human-readable mirror.

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
"Generate a moody studio shot of a black coffee mug on dark slate, 1:1, 2K resolution"

Then call the keou_generate_image tool with that prompt and poll keou_get_status until ready, then show me the URL.

Step 6 — Welcome guide:
Once the test image is ready and I've seen it, call the keou_welcome tool. It returns a structured guide with example prompts, key concepts, and pro tips. Don't dump the whole thing on me — pick ONE example that matches what I might want to do next (ask me if unclear) and offer to run it with me.

Important:
- Be friendly and patient, I might be new to coding
- Explain WHAT each step does in one sentence before running it
- If a command fails, debug it for me — don't just dump errors
- After step 6, follow my lead — don't keep going off-script
```

---

## Length check

Last verified: 1700 chars raw, ~2400 URL-encoded — well under the 5000-char
deeplink limit. The longer step 6 + welcome integration adds ~300 chars
but stays comfortable.
