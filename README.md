# WhatsApp Agent

A small web app that links to a WhatsApp account (like WhatsApp Web), shows all chats, and lets you switch on an LLM agent per chat that writes replies for you. Built for a garage owner who wants the first diagnostic questions to new customers handled automatically.

## Setup

```bash
npm install
cp .env.example .env     # then paste your OpenRouter key into .env
npm start                # http://localhost:3000
```

Open the app, then on the phone go to **WhatsApp → Settings → Linked devices → Link a device** and scan the QR code. Chats appear as WhatsApp syncs them (this can take a minute).

## How it works

- **Agents are per chat and opt-in.** Open a chat → **Add agent**. Nothing is created for other chats.
- **Approval by default.** When the customer writes, the agent waits a few seconds (so several quick messages get one answer), then writes a **suggested reply**. You can edit it, send it, rewrite it, or discard it. Chats waiting for you show under **Needs review**.
- **Auto-send** (per chat toggle): replies go out right away. Capped at 10 per chat per hour.
- **Hand-off:** the agent can say "you should take over" (e.g. the customer wants a price) instead of replying. It can also decide no reply is needed.
- If you reply from your phone, any pending suggestion for that chat is dropped.
- **Photos** the customer sends are shown to the model (the most recent 4 by default).

## Prompts (all editable)

- **Settings → Shared instructions:** the garage's questions and rules. Used by every chat.
- **Per chat:** use the shared instructions, add extra ones for that chat, or replace them entirely. **See full prompt** shows exactly what the model gets.
- **Settings → Advanced:** the base prompt (tone, hand-off rules), the model (any OpenRouter model id; default `anthropic/claude-sonnet-5.5`), wait time, history length and limits.

## Important caveats

- This uses **Baileys**, an unofficial WhatsApp Web library. It's not approved by WhatsApp. Accounts that send automated messages can get banned, especially to people who never messaged first. Keep the agent to replying to inbound customers. The official alternative is the WhatsApp Business Cloud API, but it needs a separate number and can't read existing chats.
- The app must keep running for the agent to work (a laptop that sleeps will miss messages until it wakes; Baileys then catches up).
- Login and chat data are stored in `./data`. Treat that folder like a password. If you run it on a server, set `APP_PASSWORD` in `.env`.

## TODO

- [ ] Voice notes: transcribe (e.g. Whisper via OpenRouter / another API) and pass the text to the agent
- [ ] Videos: extract a few frames, or transcribe the audio
- [ ] PDFs and other documents as model input
- [ ] Browser/phone notification when a suggested reply is waiting
- [ ] Merge duplicate chats when WhatsApp reports the same person under two ids (phone number and "LID")
- [ ] Send photos from the app
