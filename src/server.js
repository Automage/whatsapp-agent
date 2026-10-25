import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, saveApp, getAgent } from './store.js';
import { wa, bus, connect, sendText, getMediaFile, chatDisplayName, logout } from './whatsapp.js';
import { generate, updateAgent, approveDraft, discardDraft, agentState, systemPromptFor, defaultAgent } from './agent.js';
import { DEFAULT_SETTINGS } from './prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

// Optional password (set APP_PASSWORD) — strongly recommended if this runs anywhere but your own computer.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="WhatsApp Agent"').status(401).send('Password required');
  });
}

app.use(express.static(path.join(here, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const chatIdOf = (req) => {
  const id = req.params.id;
  if (!db.chats[id]) throw new Error('Unknown chat');
  return id;
};
const publicMessage = ({ raw, ...m }) => m;

function chatSummary(chat) {
  const last = db.messages[chat.id]?.at(-1);
  const agent = getAgent(chat.id);
  return {
    id: chat.id,
    name: chatDisplayName(chat),
    phone: chat.phone,
    isGroup: chat.isGroup,
    lastTs: chat.lastTs,
    unread: chat.unread || 0,
    preview: last ? (last.fromMe ? 'You: ' : '') + (last.text || `[${last.kind}]`) : '',
    agent: agent ? { enabled: agent.enabled, autoSend: agent.autoSend } : null,
    draft: db.drafts[chat.id]?.status || null,
    agentState: agentState[chat.id] || null,
  };
}

app.get('/api/status', (req, res) => res.json({ ...wa, hasApiKey: !!process.env.OPENROUTER_API_KEY }));

app.post('/api/logout', wrap(async (req, res) => { await logout(); res.json({ ok: true }); }));

app.get('/api/chats', (req, res) => {
  const chats = Object.values(db.chats)
    .filter((c) => c.lastTs || db.messages[c.id]?.length)
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    .map(chatSummary);
  res.json(chats);
});

app.get('/api/chats/:id', wrap((req, res) => {
  const id = chatIdOf(req);
  res.json({
    chat: chatSummary(db.chats[id]),
    messages: (db.messages[id] || []).map(publicMessage),
    agent: getAgent(id),
    draft: db.drafts[id] || null,
  });
}));

app.post('/api/chats/:id/read', wrap((req, res) => {
  db.chats[chatIdOf(req)].unread = 0;
  bus.emit('chats');
  res.json({ ok: true });
}));

app.post('/api/chats/:id/send', wrap(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) throw new Error('Message is empty');
  res.json(publicMessage(await sendText(chatIdOf(req), text)));
}));

app.put('/api/chats/:id/agent', wrap((req, res) => res.json(updateAgent(chatIdOf(req), req.body))));

app.delete('/api/chats/:id/agent', wrap((req, res) => {
  const id = chatIdOf(req);
  updateAgent(id, { enabled: false });
  delete db.agents[id];
  delete db.drafts[id];
  saveApp();
  bus.emit('agent', { chatId: id });
  res.json({ ok: true });
}));

app.get('/api/chats/:id/prompt', wrap((req, res) => res.json({ prompt: systemPromptFor(chatIdOf(req)) })));

app.post('/api/chats/:id/generate', wrap(async (req, res) => {
  const id = chatIdOf(req);
  if (!getAgent(id)) updateAgent(id, defaultAgent());
  res.json({ draft: await generate(id, { trigger: 'manual' }) });
}));

app.post('/api/chats/:id/draft/approve', wrap(async (req, res) => {
  await approveDraft(chatIdOf(req), req.body.text);
  res.json({ ok: true });
}));

app.delete('/api/chats/:id/draft', wrap((req, res) => { discardDraft(chatIdOf(req)); res.json({ ok: true }); }));

app.get('/api/media/:id/:msgId', wrap(async (req, res) => {
  const media = await getMediaFile(chatIdOf(req), req.params.msgId);
  if (!media) return res.status(404).end();
  res.type(media.mimetype).sendFile(media.file);
}));

app.get('/api/settings', (req, res) => res.json({ settings: db.settings, defaults: DEFAULT_SETTINGS }));
app.put('/api/settings', (req, res) => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in req.body) db.settings[k] = req.body[k];
  saveApp();
  res.json(db.settings);
});

// Live updates for the browser (Server-Sent Events).
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (type, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers = {
    status: () => send('status'),
    chats: () => send('chats'),
    messages: (d) => send('messages', d),
    agent: (d) => send('agent', d),
  };
  // chat list updates can be very bursty during history sync: throttle them
  let chatsTimer = null;
  handlers.chats = () => { if (!chatsTimer) chatsTimer = setTimeout(() => { chatsTimer = null; send('chats'); }, 500); };
  for (const [k, fn] of Object.entries(handlers)) bus.on(k, fn);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clearTimeout(chatsTimer);
    for (const [k, fn] of Object.entries(handlers)) bus.off(k, fn);
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`WhatsApp Agent running at http://localhost:${port}`);
  if (!process.env.OPENROUTER_API_KEY) console.warn('Warning: OPENROUTER_API_KEY is not set — the agent cannot write replies until you add it to .env');
});
connect().catch((e) => console.error('WhatsApp connection failed', e));
