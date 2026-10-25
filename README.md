# WhatsApp Agent

A small web app that links to a WhatsApp account (like WhatsApp Web), shows all chats, and lets you switch on an LLM agent per chat that writes replies for you.

## Setup

```bash
npm install
cp .env.example .env     # then paste your OpenRouter key into .env
npm start                # http://localhost:3000
```

Open the app, then on the phone go to **WhatsApp → Settings → Linked devices → Link a device** and scan the QR code. Chats appear as WhatsApp syncs them (this can take a minute).

## How it works

- **Agents are per chat and opt-in.** Open a chat → **Add agent**. Nothing is created for other chats.
- **Approval by default.** When someone writes, the agent waits a few seconds (so several quick messages get one answer), then writes a **suggested reply**. You can edit it, send it, rewrite it, or discard it. Chats waiting for you show under **Needs review**.
- **Auto-send** (per chat toggle): replies go out right away. Capped at 10 per chat per hour.
- **Hand-off:** the agent can say "you should take over" (e.g. something it can't answer) instead of replying. It can also decide no reply is needed.
- If you reply from your phone, any pending suggestion for that chat is dropped.
- **Photos** people send are shown to the model (the most recent 4 by default).

## Prompts, models and cost

- **Settings → Prompt:** your instructions for the agent. Used by every chat.
- **Settings → System message:** added before your prompt. Holds the rules the app relies on (`[NO_REPLY]` to skip a reply, `[HANDOFF]` to hand the chat back to you). Editable, with a **Reset** button.
- **Per chat:** use the shared prompt or write a custom one. **View prompt** shows exactly what the model gets.
- **Model:** pick any OpenRouter model from the dropdown (list loaded from OpenRouter, with prices). Set a default in Settings and override it per chat. Default: `anthropic/claude-sonnet-5.5`.
- **Cost:** each chat's agent settings show what its LLM calls have cost; Settings shows the total. Numbers come from OpenRouter.
- **Settings → Advanced:** wait time, history length, photo limit and the auto-send cap.

## Important caveats

- This uses **Baileys**, an unofficial WhatsApp Web library. It's not approved by WhatsApp. Accounts that send automated messages can get banned, especially to people who never messaged first. Keep the agent to replying to people who message you first. The official alternative is the WhatsApp Business Platform (Cloud API).
- The app must keep running for the agent to work (a laptop that sleeps will miss messages until it wakes; Baileys then catches up).
- Login and chat data are stored in `./data`. Treat that folder like a password. If you run it on a server, set `APP_PASSWORD` in `.env`.

## TODO

- [ ] Voice notes: transcribe (e.g. Whisper via OpenRouter / another API) and pass the text to the agent
- [ ] Videos: extract a few frames, or transcribe the audio
- [ ] PDFs and other documents as model input
- [ ] Browser/phone notification when a suggested reply is waiting
- [ ] Merge duplicate chats when WhatsApp reports the same person under two ids (phone number and "LID")
- [ ] Send photos from the app
