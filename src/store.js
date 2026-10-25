// Simple JSON-file storage. Everything lives in ./data so it survives restarts.
import fs from 'node:fs';
import path from 'node:path';
import { BufferJSON } from 'baileys';
import { DEFAULT_SETTINGS } from './prompts.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_MESSAGES_PER_CHAT = 300;

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'), BufferJSON.reviver);
  } catch {
    return fallback;
  }
}

// chats: { [chatId]: { id, name, phone, isGroup, lastTs, unread } }
// messages: { [chatId]: Message[] } (oldest first)
const wa = load('whatsapp.json', { chats: {}, messages: {}, contacts: {}, aliases: {} });
// agents: { [chatId]: AgentConfig }, drafts: { [chatId]: Draft }
const app = load('app.json', { settings: {}, agents: {}, drafts: {} });
app.settings = { ...DEFAULT_SETTINGS, ...app.settings };
// settings from older versions
delete app.settings.basePrompt;
delete app.settings.ownerName;

export const db = {
  chats: wa.chats, messages: wa.messages, contacts: wa.contacts, aliases: wa.aliases || {},
  settings: app.settings, agents: app.agents || {}, drafts: app.drafts || {},
  // LLM spend: { total: Usage, chats: { [chatId]: Usage } }. Kept even if a chat's agent is removed.
  usage: app.usage || { total: emptyUsage(), chats: {} },
};

function emptyUsage() {
  return { cost: 0, promptTokens: 0, completionTokens: 0, calls: 0 };
}

/** Add one LLM call's usage (OpenRouter's usage object, cost in USD) to the chat and the total. */
export function recordUsage(chatId, u) {
  if (!u) return;
  for (const t of [db.usage.total, (db.usage.chats[chatId] ||= emptyUsage())]) {
    t.cost += Number(u.cost) || 0;
    t.promptTokens += u.prompt_tokens || 0;
    t.completionTokens += u.completion_tokens || 0;
    t.calls += 1;
  }
  saveApp();
}

const timers = {};
function writeLater(file, getData) {
  clearTimeout(timers[file]);
  timers[file] = setTimeout(() => {
    const tmp = path.join(DATA_DIR, file + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(getData(), BufferJSON.replacer));
    fs.renameSync(tmp, path.join(DATA_DIR, file));
  }, 1000);
}

export function saveWhatsApp() {
  writeLater('whatsapp.json', () => ({
    chats: db.chats, messages: db.messages, contacts: db.contacts, aliases: db.aliases,
  }));
}
export function saveApp() {
  writeLater('app.json', () => ({ settings: db.settings, agents: db.agents, drafts: db.drafts, usage: db.usage }));
}

/** WhatsApp sometimes uses two ids for one person (phone-number id and "lid" id). Map them to one chat. */
export function resolveChatId(...ids) {
  ids = ids.filter(Boolean);
  for (const id of ids) if (db.aliases[id]) return db.aliases[id];
  for (const id of ids) if (db.chats[id]) return id;
  return ids[0];
}
export function linkAliases(canonical, ...ids) {
  for (const id of ids) if (id && id !== canonical && db.aliases[id] !== canonical) db.aliases[id] = canonical;
}

export function upsertChat(id, patch) {
  const chat = (db.chats[id] ||= { id, name: null, phone: null, isGroup: id.endsWith('@g.us'), lastTs: 0, unread: 0 });
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (k === 'lastTs') chat.lastTs = Math.max(chat.lastTs || 0, v);
    else chat[k] = v;
  }
  saveWhatsApp();
  return chat;
}

/** Insert a message, keeping the list sorted and de-duplicated. Returns true if it was new. */
export function addMessage(chatId, msg) {
  const list = (db.messages[chatId] ||= []);
  const existing = list.findIndex((m) => m.id === msg.id);
  if (existing >= 0) {
    list[existing] = { ...list[existing], ...msg, byAgent: list[existing].byAgent || msg.byAgent };
    saveWhatsApp();
    return false;
  }
  list.push(msg);
  if (list.length > 1 && list[list.length - 2].ts > msg.ts) list.sort((a, b) => a.ts - b.ts);
  if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
  upsertChat(chatId, { lastTs: msg.ts });
  saveWhatsApp();
  return true;
}

export function getAgent(chatId) {
  return db.agents[chatId] || null;
}
