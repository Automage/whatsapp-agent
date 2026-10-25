// The per-chat reply agent. Uses OpenRouter (OpenAI-compatible API) for the LLM.
import fs from 'node:fs';
import OpenAI from 'openai';
import { db, saveApp, getAgent } from './store.js';
import { bus, sendText, getMediaFile, setTyping, chatDisplayName } from './whatsapp.js';
import { fillTemplate } from './prompts.js';

const openrouter = new OpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || 'missing',
  defaultHeaders: { 'X-Title': 'WhatsApp Agent' },
});

const timers = {};   // chatId -> debounce timer
const running = {};  // chatId -> true while generating
export const agentState = {}; // chatId -> 'waiting' | 'thinking' | 'error: ...'

function setState(chatId, state) {
  if (state) agentState[chatId] = state; else delete agentState[chatId];
  bus.emit('agent', { chatId });
}

export function defaultAgent() {
  return { enabled: true, autoSend: false, instructionsMode: 'global', customInstructions: '', autoLog: [] };
}

export function updateAgent(chatId, patch) {
  const agent = (db.agents[chatId] ||= defaultAgent());
  for (const k of ['enabled', 'autoSend', 'instructionsMode', 'customInstructions']) if (k in patch) agent[k] = patch[k];
  if (!agent.enabled) cancel(chatId);
  saveApp();
  bus.emit('agent', { chatId });
  return agent;
}

function cancel(chatId) {
  clearTimeout(timers[chatId]);
  delete timers[chatId];
  if (agentState[chatId] === 'waiting') setState(chatId, null);
}

// New message from the customer: wait a bit (they often send several messages), then reply.
bus.on('incoming', (chatId) => {
  const agent = getAgent(chatId);
  if (!agent?.enabled) return;
  clearTimeout(timers[chatId]);
  setState(chatId, 'waiting');
  timers[chatId] = setTimeout(() => {
    delete timers[chatId];
    generate(chatId, { trigger: 'auto' }).catch((e) => console.error('agent error', e));
  }, Math.max(0, Number(db.settings.debounceSeconds) || 0) * 1000);
});

// The owner replied from their phone: drop the pending draft, they've got it.
bus.on('own-message', (chatId) => {
  if (!getAgent(chatId)) return;
  cancel(chatId);
  if (db.drafts[chatId]) { delete db.drafts[chatId]; saveApp(); bus.emit('agent', { chatId }); }
});

export function instructionsFor(chatId) {
  const agent = getAgent(chatId) || defaultAgent();
  const global = db.settings.instructions || '';
  const custom = (agent.customInstructions || '').trim();
  if (agent.instructionsMode === 'custom') return custom;
  if (agent.instructionsMode === 'append' && custom) return `${global}\n\nExtra instructions for this chat:\n${custom}`;
  return global;
}

export function systemPromptFor(chatId) {
  const chat = db.chats[chatId] || { id: chatId };
  return fillTemplate(db.settings.basePrompt, {
    owner_name: db.settings.ownerName || 'the owner',
    contact_name: chatDisplayName(chat),
    now: new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' }),
    instructions: instructionsFor(chatId),
  });
}

const FORCE_NOTE = '\n\nThe owner has asked you to write a message now. Write the message itself: do not answer with [NO_REPLY] or [HANDOFF].';

const PLACEHOLDER = { audio: '[voice note]', video: '[video]', sticker: '[sticker]' };

/** Convert the chat history into OpenAI-style messages (customer = user, owner = assistant). */
async function buildMessages(chatId, { force = false } = {}) {
  const all = db.messages[chatId] || [];
  const history = all.slice(-(Number(db.settings.historyMessages) || 40));
  const maxImages = Number(db.settings.maxImages) || 0;
  const imageIds = new Set(history.filter((m) => m.kind === 'image').slice(-maxImages).map((m) => m.id));
  const isGroup = chatId.endsWith('@g.us');

  const out = [];
  for (const m of history) {
    const parts = [];
    let text = m.text || '';
    if (m.kind === 'image') {
      if (imageIds.has(m.id)) {
        try {
          const media = await getMediaFile(chatId, m.id);
          const b64 = fs.readFileSync(media.file).toString('base64');
          parts.push({ type: 'image_url', image_url: { url: `data:${media.mimetype};base64,${b64}` } });
        } catch {
          text = `[photo that could not be loaded] ${text}`;
        }
      } else text = `[photo] ${text}`;
    } else if (m.kind === 'document') text = `[file: ${m.fileName || 'document'}] ${text}`;
    else if (PLACEHOLDER[m.kind]) text = `${PLACEHOLDER[m.kind]} ${text}`;
    text = text.trim();
    if (isGroup && !m.fromMe && m.senderName) text = `${m.senderName}: ${text}`;
    if (text) parts.push({ type: 'text', text });
    if (!parts.length) continue;

    const role = m.fromMe ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }

  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', parts: [{ type: 'text', text: '[start of conversation]' }] });
  const endsWithOwner = out[out.length - 1]?.role !== 'user';
  if (endsWithOwner) {
    const nudge = force
      ? '[No new message from the customer yet. Write a follow-up message to send now.]'
      : '[No new message from the customer. Write a follow-up only if it makes sense, otherwise reply [NO_REPLY].]';
    out.push({ role: 'user', parts: [{ type: 'text', text: nudge }] });
  }
  // assistant messages must be plain text; user messages can mix text and images
  return {
    endsWithOwner,
    messages: out.map(({ role, parts }) => role === 'assistant'
      ? { role, content: parts.map((p) => p.text).join('\n') }
      : { role, content: parts }),
  };
}

function parseReply(raw) {
  const text = (raw || '').trim();
  if (!text || /^\[NO_REPLY\]/i.test(text)) return { status: 'no_reply' };
  const handoff = text.match(/^\[HANDOFF\]\s*([\s\S]*)/i);
  if (handoff) return { status: 'handoff', reason: handoff[1].trim() || 'The agent asked you to take over.' };
  return { status: 'pending', text };
}

function underAutoCap(agent) {
  const hourAgo = Date.now() - 3600_000;
  agent.autoLog = (agent.autoLog || []).filter((t) => t > hourAgo);
  return agent.autoLog.length < (Number(db.settings.maxAutoRepliesPerHour) || 10);
}

/**
 * Write a reply for this chat. trigger: 'auto' (new customer message) or 'manual' (button in the UI).
 * Auto-send only happens for 'auto' triggers when the chat has auto-send on.
 */
export async function generate(chatId, { trigger = 'manual' } = {}) {
  const agent = getAgent(chatId);
  if (!agent) throw new Error('No agent for this chat');
  if (running[chatId]) return db.drafts[chatId];
  if (!process.env.OPENROUTER_API_KEY) {
    setState(chatId, 'error: OPENROUTER_API_KEY is not set');
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  running[chatId] = true;
  setState(chatId, 'thinking');
  const lastIdBefore = db.messages[chatId]?.at(-1)?.id;

  try {
    // When the owner clicks a button asking for a reply, always write one.
    const force = trigger === 'manual';
    const { messages, endsWithOwner } = await buildMessages(chatId, { force });
    if (trigger === 'auto' && endsWithOwner) return null; // owner already replied
    const res = await openrouter.chat.completions.create({
      model: db.settings.model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPromptFor(chatId) + (force ? FORCE_NOTE : '') },
        ...messages,
      ],
    });
    const reply = parseReply(res.choices?.[0]?.message?.content);

    // A new message came in while we were writing: start over so the reply covers it.
    if (db.messages[chatId]?.at(-1)?.id !== lastIdBefore) {
      running[chatId] = false;
      return await generate(chatId, { trigger });
    }

    const draft = { ...reply, createdAt: Date.now(), model: db.settings.model, trigger };
    if (reply.status === 'pending' && trigger === 'auto' && agent.autoSend && underAutoCap(agent)) {
      await setTyping(chatId, true);
      await new Promise((r) => setTimeout(r, Math.min(4000, 800 + reply.text.length * 25)));
      await sendText(chatId, reply.text, { byAgent: true });
      await setTyping(chatId, false);
      agent.autoLog.push(Date.now());
      delete db.drafts[chatId];
    } else {
      if (reply.status === 'pending' && trigger === 'auto' && agent.autoSend) draft.note = 'Auto-send paused: hourly limit reached.';
      db.drafts[chatId] = draft;
    }
    saveApp();
    setState(chatId, null);
    return db.drafts[chatId] || null;
  } catch (e) {
    console.error(`[agent ${chatId}]`, e.message);
    setState(chatId, `error: ${e.message}`);
    throw e;
  } finally {
    running[chatId] = false;
    if (agentState[chatId] === 'thinking') setState(chatId, null);
    bus.emit('agent', { chatId });
  }
}

export async function approveDraft(chatId, text) {
  const draft = db.drafts[chatId];
  const body = (text ?? draft?.text ?? '').trim();
  if (!body) throw new Error('Nothing to send');
  await sendText(chatId, body, { byAgent: true });
  delete db.drafts[chatId];
  saveApp();
  bus.emit('agent', { chatId });
}

export function discardDraft(chatId) {
  delete db.drafts[chatId];
  saveApp();
  bus.emit('agent', { chatId });
}
