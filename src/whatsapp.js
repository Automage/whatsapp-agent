// WhatsApp connection via Baileys (unofficial WhatsApp Web protocol). Logs in by QR code.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  normalizeMessageContent, getContentType, downloadMediaMessage, proto,
  jidNormalizedUser, isJidStatusBroadcast, isJidNewsletter, isJidBroadcast,
} from 'baileys';
import { db, AUTH_DIR, MEDIA_DIR, addMessage, upsertChat, resolveChatId, linkAliases, saveWhatsApp } from './store.js';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

/** UI + agent listen here. Events: 'status', 'chats', 'messages' ({chatId}), 'incoming', 'own-message'. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const wa = { status: 'starting', qr: null, me: null };
let sock = null;
const recentlySent = new Map(); // msgId -> message content, needed for WhatsApp's retry requests
export const sentByApp = new Set(); // ids of messages this app sent

function setStatus(patch) {
  Object.assign(wa, patch);
  bus.emit('status', wa);
}

const toNum = (v) => (v == null ? 0 : typeof v === 'number' ? v : typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
const phoneOf = (...jids) => jids.find((j) => j?.endsWith('@s.whatsapp.net'))?.split('@')[0] || null;
const skipJid = (jid) => !jid || isJidStatusBroadcast(jid) || isJidNewsletter(jid) || isJidBroadcast(jid);

export async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  setStatus({ status: 'connecting' });

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    syncFullHistory: true,
    markOnlineOnConnect: false, // keep phone notifications working
    getMessage: async (key) => recentlySent.get(key.id),
  });
  const thisSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (thisSock !== sock) return;
    if (u.qr) setStatus({ status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 300 }) });
    if (u.connection === 'open') {
      setStatus({ status: 'open', qr: null, me: { id: jidNormalizedUser(sock.user?.id), name: sock.user?.name } });
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      console.log(`WhatsApp disconnected (${code ?? 'no code'}): ${u.lastDisconnect?.error?.message || ''}`);
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setStatus({ status: 'logged_out', qr: null, me: null });
        setTimeout(connect, 1000); // start fresh: shows a new QR code
      } else {
        setStatus({ status: 'reconnecting' });
        setTimeout(connect, code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
    for (const m of lidPnMappings || []) linkLid(m.lid, m.pn);
    for (const c of contacts || []) saveContact(c);
    for (const c of chats || []) saveChat(c);
    for (const m of messages || []) ingest(m);
    bus.emit('chats');
  });
  sock.ev.on('lid-mapping.update', (m) => linkLid(m.lid, m.pn));
  sock.ev.on('contacts.upsert', (cs) => { cs.forEach(saveContact); bus.emit('chats'); });
  sock.ev.on('contacts.update', (cs) => { cs.forEach(saveContact); bus.emit('chats'); });
  sock.ev.on('chats.upsert', (cs) => { cs.forEach(saveChat); bus.emit('chats'); });
  sock.ev.on('chats.update', (cs) => { cs.forEach(saveChat); bus.emit('chats'); });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const raw of messages) {
      const res = ingest(raw);
      if (!res?.isNew || type !== 'notify') continue;
      const { chatId, record } = res;
      if (record.fromMe) {
        if (!sentByApp.has(record.id)) bus.emit('own-message', chatId, record);
      } else {
        db.chats[chatId].unread = (db.chats[chatId].unread || 0) + 1;
        bus.emit('incoming', chatId, record);
      }
    }
    bus.emit('chats');
  });
}

function linkLid(lid, pn) {
  if (!lid || !pn) return;
  const id = resolveChatId(pn, lid);
  linkAliases(id, pn, lid);
  saveWhatsApp();
}

function saveContact(c) {
  if (!c?.id || skipJid(c.id)) return;
  const id = resolveChatId(c.id, c.lid, c.phoneNumber);
  linkAliases(id, c.id, c.lid, c.phoneNumber);
  const prev = db.contacts[id] || {};
  db.contacts[id] = {
    name: c.name ?? prev.name, notify: c.notify ?? prev.notify, verifiedName: c.verifiedName ?? prev.verifiedName,
    phone: phoneOf(c.id, c.phoneNumber) ?? prev.phone,
  };
  if (db.chats[id]) upsertChat(id, { phone: db.contacts[id].phone });
  saveWhatsApp();
}

function saveChat(c) {
  if (skipJid(c.id)) return;
  const id = resolveChatId(c.id, c.pnJid, c.lidJid);
  linkAliases(id, c.id, c.pnJid, c.lidJid);
  upsertChat(id, {
    name: c.name || undefined,
    phone: phoneOf(c.id, c.pnJid),
    lastTs: c.conversationTimestamp ? toNum(c.conversationTimestamp) : undefined,
    unread: typeof c.unreadCount === 'number' && c.unreadCount >= 0 ? c.unreadCount : undefined,
  });
}

/** Turn a raw Baileys message into our simple record and store it. */
function ingest(raw) {
  const key = raw?.key;
  const jid = key?.remoteJid;
  if (skipJid(jid)) return null;
  const content = normalizeMessageContent(raw.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || ['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage'].includes(type)) return null;
  const c = content[type];

  let kind = 'text', text = '', mimetype, fileName;
  switch (type) {
    case 'conversation': text = content.conversation; break;
    case 'extendedTextMessage': text = c.text; break;
    case 'imageMessage': kind = 'image'; text = c.caption || ''; mimetype = c.mimetype; break;
    case 'videoMessage': case 'ptvMessage': kind = 'video'; text = c.caption || ''; mimetype = c.mimetype; break;
    case 'audioMessage': kind = 'audio'; mimetype = c.mimetype; break;
    case 'stickerMessage': kind = 'sticker'; mimetype = c.mimetype; break;
    case 'documentMessage': case 'documentWithCaptionMessage': {
      const d = type === 'documentMessage' ? c : c.message?.documentMessage || {};
      kind = 'document'; text = d.caption || ''; mimetype = d.mimetype; fileName = d.fileName; break;
    }
    case 'locationMessage': case 'liveLocationMessage':
      text = `[location: ${c.degreesLatitude}, ${c.degreesLongitude}${c.name ? ` (${c.name})` : ''}${c.address ? ` ${c.address}` : ''}]`; break;
    case 'contactMessage': text = `[contact card: ${c.displayName}]`; break;
    case 'pollCreationMessage': case 'pollCreationMessageV3': text = `[poll: ${c.name}]`; break;
    default: text = `[${type.replace(/Message$/, '')}]`;
  }

  const chatId = resolveChatId(jid, key.remoteJidAlt);
  linkAliases(chatId, jid, key.remoteJidAlt);
  const isGroup = chatId.endsWith('@g.us');
  upsertChat(chatId, {
    phone: isGroup ? undefined : phoneOf(jid, key.remoteJidAlt),
    pushName: !isGroup && !key.fromMe && raw.pushName ? raw.pushName : undefined,
  });

  const record = {
    id: key.id,
    fromMe: !!key.fromMe,
    ts: toNum(raw.messageTimestamp) || Math.floor(Date.now() / 1000),
    kind, text: text || '', mimetype, fileName,
    senderName: isGroup && !key.fromMe ? raw.pushName || key.participant?.split('@')[0] : undefined,
  };
  if (kind !== 'text') record.raw = { key, message: raw.message }; // needed to download the media later
  const isNew = addMessage(chatId, record);
  if (isNew) bus.emit('messages', { chatId });
  return { chatId, record, isNew };
}

export function chatDisplayName(chat) {
  const contact = db.contacts[chat.id] || {};
  return contact.name || chat.name || contact.verifiedName || contact.notify || chat.pushName || (chat.phone ? '+' + chat.phone : chat.id.split('@')[0]);
}

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };

/** Download (once) and cache a message's photo/video/etc. Returns { file, mimetype } or null. */
export async function getMediaFile(chatId, msgId) {
  const msg = db.messages[chatId]?.find((m) => m.id === msgId);
  if (!msg?.raw) return null;
  const mimetype = (msg.mimetype || 'application/octet-stream').split(';')[0];
  const file = path.join(MEDIA_DIR, msgId.replace(/[^\w-]/g, '_') + (EXT[mimetype] || ''));
  if (!fs.existsSync(file)) {
    if (!sock) throw new Error('WhatsApp is not connected');
    const buf = await downloadMediaMessage(
      { key: msg.raw.key, message: proto.Message.fromObject(msg.raw.message) },
      'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage },
    );
    fs.writeFileSync(file, buf);
  }
  return { file, mimetype };
}

/** Send a text message. Returns the stored record. */
export async function sendText(chatId, text, { byAgent = false } = {}) {
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  const sent = await sock.sendMessage(chatId, { text });
  sentByApp.add(sent.key.id);
  recentlySent.set(sent.key.id, sent.message);
  if (recentlySent.size > 200) recentlySent.delete(recentlySent.keys().next().value);
  ingest(sent);
  const record = db.messages[chatId]?.find((m) => m.id === sent.key.id);
  if (record && byAgent) record.byAgent = true;
  saveWhatsApp();
  bus.emit('messages', { chatId });
  bus.emit('chats');
  return record;
}

export async function setTyping(chatId, on) {
  try { await sock?.sendPresenceUpdate(on ? 'composing' : 'paused', chatId); } catch {}
}

export async function logout() {
  try { await sock?.logout(); } catch {}
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}
