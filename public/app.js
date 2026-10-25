const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const chatUrl = (id, rest = '') => `/api/chats/${encodeURIComponent(id)}${rest}`;

const state = { chats: [], filter: 'all', search: '', currentId: null, current: null, showAgent: false, draftEdit: null };

// ---------- connection status ----------
async function loadStatus() {
  const s = await api('/api/status');
  const labels = { open: 'Connected', qr: 'Not linked', connecting: 'Connecting…', reconnecting: 'Reconnecting…', logged_out: 'Logged out', starting: 'Starting…' };
  $('conn').textContent = labels[s.status] + (s.me?.name ? ` · ${s.me.name}` : '');
  $('conn').classList.toggle('ok', s.status === 'open');
  const needsQr = s.status === 'qr' || s.status === 'logged_out';
  $('qrOverlay').classList.toggle('hidden', !needsQr);
  if (s.qr) { $('qrImg').src = s.qr; $('qrHint').textContent = 'The code refreshes every ~20 seconds.'; }
  $('banner').classList.toggle('hidden', s.hasApiKey);
  $('banner').textContent = 'OPENROUTER_API_KEY is not set. Add it to the .env file and restart, or the agent can’t write replies.';
}

// ---------- chat list ----------
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

async function loadChats() {
  state.chats = await api('/api/chats');
  renderChats();
}

function renderChats() {
  const q = state.search.toLowerCase();
  const list = state.chats.filter((c) => {
    if (state.filter === 'agent' && !c.agent) return false;
    if (state.filter === 'drafts' && !c.draft) return false;
    return !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q);
  });
  $('chatList').innerHTML = list.slice(0, 500).map((c) => {
    const badges = [];
    if (c.draft === 'pending') badges.push('<span class="badge warn">Draft</span>');
    if (c.draft === 'handoff') badges.push('<span class="badge warn">Needs you</span>');
    if (c.agentState === 'thinking') badges.push('<span class="badge">Writing…</span>');
    if (c.agent) badges.push(`<span class="badge">${c.agent.enabled ? (c.agent.autoSend ? 'Auto' : 'Agent') : 'Agent off'}</span>`);
    if (c.unread) badges.push(`<span class="badge count">${c.unread}</span>`);
    return `<li class="chat-item ${c.id === state.currentId ? 'active' : ''}" data-id="${esc(c.id)}">
      <div class="name">${esc(c.name)}</div><div class="time">${fmtTime(c.lastTs)}</div>
      <div class="preview">${esc(c.preview)}</div><div class="badges">${badges.join('')}</div>
    </li>`;
  }).join('') || '<li class="chat-item"><span class="muted">No chats yet. They appear once WhatsApp finishes syncing.</span></li>';
}

$('chatList').addEventListener('click', (e) => {
  const li = e.target.closest('[data-id]');
  if (li) openChat(li.dataset.id);
});
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderChats(); });
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  state.filter = t.dataset.filter;
  renderChats();
}));

// ---------- open chat ----------
async function openChat(id) {
  if (state.currentId !== id) state.draftEdit = null;
  state.currentId = id;
  $('layout').classList.add('has-chat');
  $('emptyState').classList.add('hidden');
  $('chatInner').classList.remove('hidden');
  await loadCurrent(true);
  api(chatUrl(id, '/read'), { method: 'POST' }).catch(() => {});
  renderChats();
}

async function loadCurrent(scrollToEnd = false) {
  if (!state.currentId) return;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  state.current = await api(chatUrl(state.currentId));
  renderChat();
  if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMessage(m, chatId) {
  const media = `/api/media/${encodeURIComponent(chatId)}/${encodeURIComponent(m.id)}`;
  let body = '';
  if (m.kind === 'image' || m.kind === 'sticker') body += `<img src="${media}" loading="lazy" alt="photo" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:'[photo could not be loaded]'}))" />`;
  if (m.kind === 'audio') body += `<audio controls preload="none" src="${media}"></audio><div class="placeholder">Voice note (agent can’t listen yet)</div>`;
  if (m.kind === 'video') body += `<div class="placeholder"><a href="${media}" target="_blank">Video</a> (agent can’t watch yet)</div>`;
  if (m.kind === 'document') body += `<div class="placeholder"><a href="${media}" target="_blank">${esc(m.fileName || 'File')}</a></div>`;
  if (m.text) body += `<div class="text">${esc(m.text)}</div>`;
  const time = new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="msg ${m.fromMe ? 'me' : ''}">
    ${m.senderName ? `<div class="sender">${esc(m.senderName)}</div>` : ''}${body}
    <div class="meta">${m.byAgent ? 'Agent · ' : ''}${time}</div></div>`;
}

function renderChat() {
  const { chat, messages, agent, draft } = state.current;
  $('chatTitle').textContent = chat.name;
  $('chatSub').textContent = [chat.phone && '+' + chat.phone, chat.isGroup && 'Group'].filter(Boolean).join(' · ');
  $('agentToggleBtn').textContent = agent ? (agent.enabled ? (agent.autoSend ? 'Agent: auto-send' : 'Agent: on') : 'Agent: off') : 'Add agent';

  let html = '', lastDay = '';
  for (const m of messages) {
    const day = new Date(m.ts * 1000).toDateString();
    if (day !== lastDay) { html += `<div class="day">${new Date(m.ts * 1000).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>`; lastDay = day; }
    html += renderMessage(m, chat.id);
  }
  $('messages').innerHTML = html || '<div class="empty">No messages stored for this chat yet.</div>';
  renderDraft(chat, agent, draft);
  renderAgentPanel();
}

function renderDraft(chat, agent, draft) {
  // don't wipe the box while someone is editing the same draft
  const key = JSON.stringify([draft?.createdAt, draft?.status, chat.agentState]);
  if (document.activeElement?.id === 'draftText' && key === state.draftKey) return;
  state.draftKey = key;
  let html = '';
  const st = chat.agentState;
  if (st === 'waiting') html += `<div class="status-line">Waiting for the customer to finish typing, then the agent will write a reply…</div>`;
  if (st === 'thinking') html += `<div class="status-line">Agent is writing a reply…</div>`;
  if (st?.startsWith('error')) html += `<div class="status-line error">Agent ${esc(st)}</div>`;

  if (draft?.status === 'pending') {
    const text = state.draftEdit ?? draft.text;
    html += `<div class="draft">
      <div class="label">Suggested reply — check it, edit if needed, then send</div>
      ${draft.note ? `<div class="muted">${esc(draft.note)}</div>` : ''}
      <textarea id="draftText" rows="3">${esc(text)}</textarea>
      <div class="row">
        <button class="btn primary" data-act="approve">Send</button>
        <button class="btn" data-act="regen">Rewrite</button>
        <div class="spacer"></div>
        <button class="btn" data-act="discard">Discard</button>
      </div></div>`;
  } else if (draft?.status === 'handoff') {
    html += `<div class="draft warn">
      <div class="label">The agent suggests you take over</div>
      <div>${esc(draft.reason)}</div>
      <div class="row"><button class="btn" data-act="regen">Write a reply anyway</button><div class="spacer"></div><button class="btn" data-act="discard">Dismiss</button></div></div>`;
  } else if (draft?.status === 'no_reply') {
    html += `<div class="draft">
      <div class="label">${(state.current.messages.at(-1) || {}).fromMe
        ? 'No reply written: the last message in this chat is yours'
        : 'The agent thinks no reply is needed right now'}</div>
      <div class="row"><button class="btn" data-act="regen">Write a follow-up anyway</button><div class="spacer"></div><button class="btn" data-act="discard">Dismiss</button></div></div>`;
  } else if (agent?.enabled && st !== 'thinking') {
    html += `<div class="status-line"><button class="btn small" data-act="regen">Write a reply now</button></div>`;
  }
  $('draftArea').innerHTML = html;
  $('draftText')?.addEventListener('input', (e) => { state.draftEdit = e.target.value; });
}

$('draftArea').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const id = state.currentId;
  e.target.disabled = true;
  try {
    if (act === 'approve') { await api(chatUrl(id, '/draft/approve'), { method: 'POST', body: { text: $('draftText').value } }); state.draftEdit = null; }
    if (act === 'discard') { await api(chatUrl(id, '/draft'), { method: 'DELETE' }); state.draftEdit = null; }
    if (act === 'regen') { state.draftEdit = null; await api(chatUrl(id, '/generate'), { method: 'POST' }); }
  } catch (err) { alert(err.message); }
  await loadCurrent();
});

// ---------- composer (manual send) ----------
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('composerInput').value.trim();
  if (!text) return;
  try {
    await api(chatUrl(state.currentId, '/send'), { method: 'POST', body: { text } });
    $('composerInput').value = '';
    await loadCurrent(true);
  } catch (err) { alert(err.message); }
});
$('composerInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('backBtn').addEventListener('click', () => { state.currentId = null; $('layout').classList.remove('has-chat'); $('agentPanel').classList.add('hidden'); renderChats(); });

// ---------- agent panel ----------
$('agentToggleBtn').addEventListener('click', () => { state.showAgent = !state.showAgent; renderAgentPanel(); });

function renderAgentPanel() {
  const panel = $('agentPanel');
  panel.classList.toggle('hidden', !state.showAgent || !state.current);
  if (!state.showAgent || !state.current) return;
  if (document.activeElement?.id === 'customInstr' && panel.dataset.chat === state.currentId) return; // keep typing
  panel.dataset.chat = state.currentId;
  const { agent } = state.current;
  const close = '<div class="row"><h3>Agent for this chat</h3><div class="spacer"></div><button class="btn icon" data-a="close" aria-label="Close">✕</button></div>';
  if (!agent) {
    panel.innerHTML = `${close}
      <p class="muted">No agent in this chat yet. When you add one, it reads new messages from this person and writes replies for you, using your shared instructions.</p>
      <button class="btn primary" data-a="create">Add agent to this chat</button>`;
    return;
  }
  const mode = agent.instructionsMode;
  panel.innerHTML = `${close}
    <label class="switch"><input type="checkbox" data-a="enabled" ${agent.enabled ? 'checked' : ''}/>
      <span>Agent is on<small>Writes a reply when a new message comes in.</small></span></label>
    <label class="switch"><input type="checkbox" data-a="autoSend" ${agent.autoSend ? 'checked' : ''}/>
      <span>Send without asking me<small>Off: replies wait for you to approve them. On: replies go out right away.</small></span></label>
    <div class="section">
      <h3>Instructions</h3>
      <label class="radio"><input type="radio" name="mode" value="global" ${mode === 'global' ? 'checked' : ''}/><span>Use shared instructions</span></label>
      <label class="radio"><input type="radio" name="mode" value="append" ${mode === 'append' ? 'checked' : ''}/><span>Shared instructions + extra for this chat</span></label>
      <label class="radio"><input type="radio" name="mode" value="custom" ${mode === 'custom' ? 'checked' : ''}/><span>Only this chat’s own instructions</span></label>
      <textarea id="customInstr" rows="8" placeholder="${mode === 'custom' ? 'Instructions for this chat only' : 'Extra instructions for this chat, e.g. “This is a repeat customer, their car is a 2015 Golf.”'}" ${mode === 'global' ? 'disabled' : ''}>${esc(agent.customInstructions)}</textarea>
      <div class="row"><button class="btn primary small" data-a="saveInstr">Save instructions</button><span class="muted" id="instrSaved"></span>
        <div class="spacer"></div><button class="btn small" data-a="prompt">See full prompt</button></div>
      <p class="muted">Edit the shared instructions in Settings.</p>
    </div>
    <div class="section"><button class="btn danger small" data-a="remove">Remove agent from this chat</button></div>`;
}

$('agentPanel').addEventListener('change', async (e) => {
  const a = e.target.dataset.a;
  if (a === 'enabled' || a === 'autoSend') {
    if (a === 'autoSend' && e.target.checked && !confirm('Replies will be sent to this customer without you checking them first. Turn on?')) { e.target.checked = false; return; }
    await api(chatUrl(state.currentId, '/agent'), { method: 'PUT', body: { [a]: e.target.checked } });
    await loadCurrent(); loadChats();
  }
  if (e.target.name === 'mode') {
    await api(chatUrl(state.currentId, '/agent'), { method: 'PUT', body: { instructionsMode: e.target.value, customInstructions: $('customInstr').value } });
    await loadCurrent();
  }
});

$('agentPanel').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  const id = state.currentId;
  if (a === 'close') { state.showAgent = false; renderAgentPanel(); }
  if (a === 'create') { await api(chatUrl(id, '/agent'), { method: 'PUT', body: { enabled: true } }); await loadCurrent(); loadChats(); }
  if (a === 'saveInstr') {
    await api(chatUrl(id, '/agent'), { method: 'PUT', body: { customInstructions: $('customInstr').value } });
    $('instrSaved').textContent = 'Saved';
    setTimeout(() => $('instrSaved') && ($('instrSaved').textContent = ''), 1500);
  }
  if (a === 'prompt') {
    const { prompt } = await api(chatUrl(id, '/prompt'));
    $('promptText').textContent = prompt;
    $('promptOverlay').classList.remove('hidden');
  }
  if (a === 'remove' && confirm('Remove the agent and its settings from this chat?')) {
    await api(chatUrl(id, '/agent'), { method: 'DELETE' }); await loadCurrent(); loadChats();
  }
});
$('closePrompt').addEventListener('click', () => $('promptOverlay').classList.add('hidden'));

// ---------- settings ----------
let defaults = {};
$('settingsBtn').addEventListener('click', async () => {
  const { settings, defaults: d } = await api('/api/settings');
  defaults = d;
  const form = $('settingsForm');
  for (const [k, v] of Object.entries(settings)) if (form.elements[k]) form.elements[k].value = v;
  $('settingsSaved').textContent = '';
  $('settingsOverlay').classList.remove('hidden');
});
$('closeSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));
$('resetBasePrompt').addEventListener('click', () => { $('settingsForm').elements.basePrompt.value = defaults.basePrompt; });
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  await api('/api/settings', { method: 'PUT', body });
  $('settingsSaved').textContent = 'Saved';
});
$('logoutBtn').addEventListener('click', async () => {
  if (!confirm('Unlink this WhatsApp account from the app? You’ll need to scan a new QR code.')) return;
  await api('/api/logout', { method: 'POST' });
  $('settingsOverlay').classList.add('hidden');
});

// ---------- live updates ----------
let reloadTimer = null;
const reloadCurrentSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadCurrent().catch(() => {}), 200); };
const events = new EventSource('/api/events');
events.addEventListener('status', () => loadStatus());
events.addEventListener('chats', () => loadChats());
events.addEventListener('messages', (e) => { if (JSON.parse(e.data).chatId === state.currentId) reloadCurrentSoon(); });
events.addEventListener('agent', (e) => { if (JSON.parse(e.data).chatId === state.currentId) reloadCurrentSoon(); loadChats(); });
events.onopen = () => { loadStatus(); loadChats(); };

loadStatus();
loadChats();
