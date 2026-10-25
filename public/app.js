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
const fmtCost = (usd) => '$' + (usd >= 1 ? usd.toFixed(2) : usd.toFixed(4));
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
function usageText(u) {
  if (!u?.calls) return 'Nothing spent yet';
  return `${fmtCost(u.cost)} · ${u.calls} ${u.calls === 1 ? 'call' : 'calls'} · ${fmtTokens(u.promptTokens + u.completionTokens)} tokens`;
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
  if (s.qr) { $('qrImg').src = s.qr; $('qrHint').textContent = ''; }
  $('banner').classList.toggle('hidden', s.hasApiKey);
  $('banner').textContent = 'OPENROUTER_API_KEY is missing from .env. The agent can’t reply until it’s added.';
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
    if (c.draft === 'handoff') badges.push('<span class="badge warn">Review</span>');
    if (c.agentState === 'thinking') badges.push('<span class="badge">Writing…</span>');
    if (c.agent) badges.push(`<span class="badge">${c.agent.enabled ? (c.agent.autoSend ? 'Auto' : 'Agent') : 'Agent off'}</span>`);
    if (c.unread) badges.push(`<span class="badge count">${c.unread}</span>`);
    return `<li class="chat-item ${c.id === state.currentId ? 'active' : ''}" data-id="${esc(c.id)}">
      <div class="name">${esc(c.name)}</div><div class="time">${fmtTime(c.lastTs)}</div>
      <div class="preview">${esc(c.preview)}</div><div class="badges">${badges.join('')}</div>
    </li>`;
  }).join('') || '<li class="chat-item"><span class="muted">No chats yet.</span></li>';
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
  state.defaultModel = state.current.defaultModel;
  renderChat();
  if (scrollToEnd || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMessage(m, chatId) {
  const media = `/api/media/${encodeURIComponent(chatId)}/${encodeURIComponent(m.id)}`;
  let body = '';
  if (m.kind === 'image' || m.kind === 'sticker') body += `<img src="${media}" loading="lazy" alt="photo" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:'[photo could not be loaded]'}))" />`;
  if (m.kind === 'audio') body += `<audio controls preload="none" src="${media}"></audio><div class="placeholder">Voice note (agent can’t hear)</div>`;
  if (m.kind === 'video') body += `<div class="placeholder"><a href="${media}" target="_blank">Video</a> (agent can’t see)</div>`;
  if (m.kind === 'document') body += `<div class="placeholder"><a href="${media}" target="_blank">${esc(m.fileName || 'File')}</a></div>`;
  if (m.text) body += `<div class="text">${esc(m.text)}</div>`;
  const time = new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="msg ${m.fromMe ? 'me' : ''}">
    ${m.senderName ? `<div class="sender">${esc(m.senderName)}</div>` : ''}${body}
    <div class="meta">${m.byAgent ? 'Agent · ' : ''}${time}</div></div>`;
}

function renderChat() {
  const { chat, messages, agent, draft } = state.current;
  const pill = agent?.enabled ? (agent.autoSend ? '<span class="badge warn">Agent active · auto-send</span>' : '<span class="badge">Agent active</span>') : '';
  $('chatTitle').innerHTML = `${esc(chat.name)}${pill}`;
  $('chatSub').textContent = [chat.phone && '+' + chat.phone, chat.isGroup && 'Group'].filter(Boolean).join(' · ');
  $('agentToggleBtn').textContent = 'Agent settings';

  let html = '', lastDay = '';
  for (const m of messages) {
    const day = new Date(m.ts * 1000).toDateString();
    if (day !== lastDay) { html += `<div class="day">${new Date(m.ts * 1000).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>`; lastDay = day; }
    html += renderMessage(m, chat.id);
  }
  $('messages').innerHTML = html || '<div class="empty">No messages.</div>';
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
  if (st === 'waiting') html += `<div class="status-line">Waiting for more messages…</div>`;
  if (st === 'thinking') html += `<div class="status-line">Writing reply…</div>`;
  if (st?.startsWith('error')) html += `<div class="status-line error">Agent ${esc(st)}</div>`;

  if (draft?.status === 'pending') {
    const text = state.draftEdit ?? draft.text;
    html += `<div class="draft">
      <div class="label">Suggested reply</div>
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
      <div class="label">Agent suggests you take over</div>
      <div>${esc(draft.reason)}</div>
      <div class="row"><button class="btn" data-act="regen">Write reply</button><div class="spacer"></div><button class="btn" data-act="discard">Dismiss</button></div></div>`;
  } else if (draft?.status === 'no_reply') {
    html += `<div class="draft">
      <div class="label">${(state.current.messages.at(-1) || {}).fromMe
        ? 'Last message is yours'
        : 'No reply needed'}</div>
      <div class="row"><button class="btn" data-act="regen">Write follow-up</button><div class="spacer"></div><button class="btn" data-act="discard">Dismiss</button></div></div>`;
  } else if (agent?.enabled && st !== 'thinking') {
    html += `<div class="status-line"><button class="btn small" data-act="regen">Write reply</button></div>`;
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
  // don't re-render while someone is typing or has the model list open
  if (panel.dataset.chat === state.currentId && (document.activeElement?.id === 'customInstr' || panel.querySelector('.picker.open'))) return;
  panel.dataset.chat = state.currentId;
  const { agent } = state.current;
  const close = '<div class="row"><h3>Agent settings</h3><div class="spacer"></div><button class="btn icon" data-a="close" aria-label="Close">✕</button></div>';
  if (!agent) {
    panel.innerHTML = `${close}
      <p class="muted">Writes replies to new messages in this chat.</p>
      <button class="btn primary" data-a="create">Add agent</button>`;
    return;
  }
  const mode = agent.instructionsMode;
  panel.innerHTML = `${close}
    <label class="switch"><input type="checkbox" data-a="enabled" ${agent.enabled ? 'checked' : ''}/>
      <span>Enabled</span></label>
    <label class="switch"><input type="checkbox" data-a="autoSend" ${agent.autoSend ? 'checked' : ''}/>
      <span>Auto-send<small>Send replies without approval</small></span></label>
    <div class="section">
      <h3>Prompt</h3>
      <label class="radio"><input type="radio" name="mode" value="global" ${mode !== 'custom' ? 'checked' : ''}/><span>Shared<small>Edit in Settings</small></span></label>
      <label class="radio"><input type="radio" name="mode" value="custom" ${mode === 'custom' ? 'checked' : ''}/><span>Custom</span></label>
      ${mode === 'custom' ? `<textarea id="customInstr" rows="8" placeholder="Prompt for this chat">${esc(agent.customInstructions)}</textarea>` : ''}
      <div class="row">${mode === 'custom' ? '<button class="btn primary small" data-a="saveInstr">Save</button><span class="muted" id="instrSaved"></span>' : ''}
        <div class="spacer"></div><button class="btn small" data-a="prompt">View prompt</button></div>
    </div>
    <div class="section">
      <h3>Model</h3>
      <div id="agentModelPicker"></div>
    </div>
    <div class="section"><h3>Cost</h3><p class="muted">${usageText(state.current.usage)}</p></div>
    <div class="section"><button class="btn danger small" data-a="remove">Remove agent</button></div>`;
  $('agentModelPicker').append(modelPicker({
    value: agent.model || '',
    defaultLabel: () => `Default (${modelName(state.defaultModel)})`,
    defaultId: state.defaultModel,
    onChange: async (model) => { await api(chatUrl(state.currentId, '/agent'), { method: 'PUT', body: { model } }); await loadCurrent(); },
  }));
}

$('agentPanel').addEventListener('change', async (e) => {
  const a = e.target.dataset.a;
  if (a === 'enabled' || a === 'autoSend') {
    if (a === 'autoSend' && e.target.checked && !confirm('Send replies without approval?')) { e.target.checked = false; return; }
    await api(chatUrl(state.currentId, '/agent'), { method: 'PUT', body: { [a]: e.target.checked } });
    await loadCurrent(); loadChats();
  }
  if (e.target.name === 'mode') {
    await api(chatUrl(state.currentId, '/agent'), { method: 'PUT', body: {
      instructionsMode: e.target.value,
      // keep unsaved edits when switching away from Custom; the text comes back when Custom is picked again
      ...($('customInstr') ? { customInstructions: $('customInstr').value } : {}),
    } });
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
  if (a === 'remove' && confirm('Remove agent?')) {
    await api(chatUrl(id, '/agent'), { method: 'DELETE' }); await loadCurrent(); loadChats();
  }
});
$('closePrompt').addEventListener('click', () => $('promptOverlay').classList.add('hidden'));

// ---------- settings ----------
$('settingsBtn').addEventListener('click', async () => {
  const { settings, defaultSystemMessage: dsm, usage } = await api('/api/settings');
  defaultSystemMessage = dsm;
  $('totalUsage').textContent = usageText(usage);
  const form = $('settingsForm');
  for (const [k, v] of Object.entries(settings)) if (form.elements[k]) form.elements[k].value = v;
  $('settingsModelPicker').replaceChildren(modelPicker({
    value: settings.model,
    onChange: (model) => { form.elements.model.value = model; },
  }));
  $('settingsSaved').textContent = '';
  $('settingsOverlay').classList.remove('hidden');
});
let defaultSystemMessage = '';
$('resetSystemMessage').addEventListener('click', () => { $('settingsForm').elements.systemMessage.value = defaultSystemMessage; });
// ---------- model list (from OpenRouter) ----------
let models = [];
const price = (n) => (n >= 0 ? '$' + (n < 1 ? n.toFixed(2) : +n.toFixed(2)) : '?');
let modelsLoading = null;
function loadModels() {
  if (!modelsLoading) modelsLoading = api('/api/models').then((m) => { models = m; }).catch(() => { modelsLoading = null; });
  return modelsLoading;
}
const modelName = (id) => models.find((m) => m.id === id)?.name || id || '';
const modelMeta = (m) => `${price(m.input)} in / ${price(m.output)} out per 1M${m.photos ? '' : ' · no photos'}`;

/**
 * Searchable model dropdown. value '' means "use the default" when defaultLabel is given.
 * Keyboard: type to search, ↑/↓ to move, Enter to pick, Esc to close.
 */
function modelPicker({ value, defaultLabel, defaultId, onChange }) {
  const el = document.createElement('div');
  el.className = 'picker';
  el.innerHTML = `<button type="button" class="picker-btn"></button>
    <div class="picker-pop hidden"><input class="picker-search" placeholder="Search models" /><ul class="picker-list"></ul></div>`;
  const [btn, pop] = el.children;
  const search = pop.querySelector('input'), list = pop.querySelector('ul');
  let current = value || '', items = [], active = 0;

  const renderBtn = () => {
    const m = models.find((x) => x.id === (current || defaultId));
    const name = current ? modelName(current) : defaultLabel?.() || 'Choose a model';
    btn.innerHTML = `<span class="picker-text"><span class="picker-name">${esc(name)}</span>${m ? `<span class="picker-meta">${esc(modelMeta(m))}</span>` : ''}</span><span class="caret">▾</span>`;
  };
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    items = models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (defaultLabel && !q) items.unshift({ id: '', name: defaultLabel() });
    active = Math.min(active, Math.max(items.length - 1, 0));
    list.innerHTML = items.slice(0, 300).map((m, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''} ${m.id === current ? 'selected' : ''}">
        <div class="picker-name">${esc(m.name)}</div>${m.id ? `<div class="picker-meta">${esc(m.id)} · ${esc(modelMeta(m))}</div>` : ''}</li>`).join('')
      || `<li class="picker-empty">${models.length ? 'No matches' : 'Loading models…'}</li>`;
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = async () => {
    el.classList.add('open'); pop.classList.remove('hidden');
    search.value = ''; active = 0; renderList(); search.focus();
    await loadModels();
    active = Math.max(0, items.findIndex((m) => m.id === current)); renderList(); renderBtn();
  };
  const close = () => { el.classList.remove('open'); pop.classList.add('hidden'); };
  const choose = (i) => {
    if (!items[i]) return;
    current = items[i].id; renderBtn(); close(); onChange(current);
  };
  el._close = close;

  btn.addEventListener('click', () => (el.classList.contains('open') ? close() : open()));
  search.addEventListener('input', () => { active = 0; renderList(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); btn.focus(); e.preventDefault(); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(Number(li.dataset.i)); });

  renderBtn();
  loadModels().then(renderBtn);
  return el;
}
// close any open model list when clicking elsewhere
document.addEventListener('mousedown', (e) => {
  document.querySelectorAll('.picker.open').forEach((p) => { if (!p.contains(e.target)) p._close(); });
});

$('closeSettings').addEventListener('click', () => $('settingsOverlay').classList.add('hidden'));
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  await api('/api/settings', { method: 'PUT', body });
  $('settingsSaved').textContent = 'Saved';
});
$('logoutBtn').addEventListener('click', async () => {
  if (!confirm('Unlink WhatsApp? You’ll need to scan a new QR code.')) return;
  await api('/api/logout', { method: 'POST' });
  $('settingsOverlay').classList.add('hidden');
});

// ---------- live updates ----------
let reloadTimer = null;
const reloadCurrentSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadCurrent().catch(() => {}), 200); };
const events = new EventSource('/api/events');
// reload the page when the server restarted with (possibly) new code, so the page is never out of date
let bootId = null;
events.addEventListener('hello', (e) => {
  const id = JSON.parse(e.data).bootId;
  if (bootId && id !== bootId) location.reload();
  bootId = id;
});
events.addEventListener('status', () => loadStatus());
events.addEventListener('chats', () => loadChats());
events.addEventListener('messages', (e) => { if (JSON.parse(e.data).chatId === state.currentId) reloadCurrentSoon(); });
events.addEventListener('agent', (e) => { if (JSON.parse(e.data).chatId === state.currentId) reloadCurrentSoon(); loadChats(); });
events.onopen = () => { loadStatus(); loadChats(); };

loadStatus();
loadChats();
