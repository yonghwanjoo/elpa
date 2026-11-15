'use strict';

const STATUS = { todo: '요청', doing: '진행 중', done: '완료' };
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

/* ---------- native bridge (present only inside the desktop shell) ---------- */
const tauri = window.__TAURI__;
const native = (cmd, args) => (tauri ? tauri.core.invoke(cmd, args).catch(() => {}) : Promise.resolve());

/* ---------- state ---------- */
let state = null; // latest snapshot from GET /api/state
const ui = { view: 'chat', channelId: null, renderedChannel: null, noteId: null, mineOnly: false, addingChannel: false, dialog: null, flashId: null, authMode: 'login', teamMode: 'new' };
let noteDraft = null; // unsaved note edit: { id, title, body, timer }
let stream = null;
let pending = []; // files picked for the next message, not uploaded yet
const imageUrls = new Map(); // attachment path -> promise of a temporary signed URL
const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const INLINE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const member = (id) => state.members.find((m) => m.id === id) || { id, name: '알 수 없음', color: '#888' };
const task = (id) => state.tasks.find((t) => t.id === id);
const channel = (id) => state.channels.find((c) => c.id === id);
const avatar = (m, sm) => `<span class="avatar${sm ? ' sm' : ''}" style="background:${esc(m.color)}" title="${esc(m.name)}">${esc(m.name[0])}</span>`;

/* ---------- server ---------- */
// Supabase: login (Auth), data (Postgres + row-level security) and live updates (Realtime).
const cfg = window.ELPA_CONFIG || {};
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

const ERRORS = [
  [/invalid login credentials/i, '이메일 또는 비밀번호가 맞지 않아요.'],
  [/already registered/i, '이미 가입된 이메일이에요.'],
  [/email not confirmed/i, '이메일 인증이 아직 안 됐어요. 메일함의 인증 링크를 눌러 주세요.'],
  [/password should be at least/i, '비밀번호는 8자 이상이어야 해요.'],
  [/rate limit|too many/i, '요청이 너무 많아요. 잠시 뒤에 다시 해주세요.'],
  [/failed to fetch|network|load failed/i, '서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'],
];
function explain(error) {
  const msg = (error && error.message) || '';
  const hit = ERRORS.find(([re]) => re.test(msg));
  return hit ? hit[1] : (msg || '요청을 처리하지 못했어요.');
}
async function call(query) {
  const { data, error } = await query;
  if (error) throw new Error(explain(error));
  return data;
}
const server = {
  state: () => call(sb.rpc('get_state')),
  joinTeam: (name, teamName, inviteCode) => call(sb.rpc('join_team', { p_name: name, p_team_name: teamName || '', p_invite_code: inviteCode || '' })),
  post: (channelId, text, attachments) => call(sb.from('messages').insert({ channel_id: channelId, text, attachments: attachments || [] })),
  // Files live in a private bucket under "<team id>/<random>.<ext>"; the original name is kept on the message.
  upload: async (file) => {
    const ext = (file.name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
    const path = `${state.team.id}/${crypto.randomUUID()}${ext ? `.${ext.toLowerCase()}` : ''}`;
    const { error } = await sb.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (error) throw new Error(explain(error));
    return { path, name: file.name.slice(0, 200), size: file.size, type: (file.type || '').slice(0, 100) };
  },
  signedUrl: async (path, downloadName) => {
    const { data, error } = await sb.storage.from('attachments').createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
    if (error) throw new Error(explain(error));
    return data.signedUrl;
  },
  addChannel: (name) => call(sb.from('channels').insert({ name }).select('id').single()),
  createTask: (f) => call(sb.rpc('create_task', { p_title: f.title, p_assignee: f.assigneeId, p_due: f.due || '', p_status: f.status || 'todo', p_message_id: f.messageId || null })),
  updateTask: (id, f) => call(sb.rpc('update_task', { p_id: id, p_title: f.title ?? null, p_assignee: f.assigneeId ?? null, p_due: f.due ?? null, p_status: f.status ?? null })),
  deleteTask: (id) => call(sb.rpc('delete_task', { p_id: id })),
  addNote: () => call(sb.from('notes').insert({ title: '' }).select('id').single()),
  saveNote: (id, title, body) => call(sb.from('notes').update({ title, body }).eq('id', id)),
  deleteNote: (id) => call(sb.from('notes').delete().eq('id', id)),
  markRead: (channelId) => call(sb.rpc('mark_read', { p_channel: channelId })),
};

// Run a change on the server, then pull the new state. Returns null on failure.
async function act(run) {
  try {
    const result = await run();
    await refresh();
    return result ?? true;
  } catch (e) {
    toast('문제가 생겼어요', e.message);
    return null;
  }
}

let triedSignupDetails = false;
async function pull() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { showAuth(); return; }
  let next = await server.state();
  if (!next) {
    // Signed in but not in a team yet: finish with the details given at sign-up, otherwise ask.
    const meta = session.user.user_metadata || {};
    if (meta.name && !triedSignupDetails) {
      triedSignupDetails = true;
      try {
        await server.joinTeam(meta.name, meta.teamName, meta.inviteCode);
        next = await server.state();
      } catch (e) { ui.notice = e.message; }
    }
    if (!next) { ui.authMode = 'team'; showAuth(); return; }
  }
  applyState(next);
}

let refreshing = null;
let refreshAgain = false;
function refresh() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await pull();
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function applyState(next) {
  const prev = state;
  if (noteDraft) { // keep what is being typed; the server copy is older
    const n = next.notes.find((x) => x.id === noteDraft.id);
    if (n) { n.title = noteDraft.title; n.body = noteDraft.body; }
  }
  state = next;
  if (!channel(ui.channelId)) ui.channelId = state.channels[0] ? state.channels[0].id : null;
  showApp();
  render();
  if (prev && prev.me === next.me) announce(prev, next);
}

function connect() {
  if (stream) return;
  // Any change a teammate makes to a row we may read arrives here; then re-pull the state.
  stream = sb.channel('team-changes')
    .on('postgres_changes', { event: '*', schema: 'public' }, () => refresh().catch(() => {}))
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh().catch(() => {}); }); // catch up after a reconnect
}

/* ---------- notifications ---------- */
function toast(title, body) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b>${esc(body || '')}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}
function notify(title, body) {
  toast(title, body);
  if (tauri) native('notify', { title, body });
  else if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body });
}

// Tell the user about what teammates just did.
function announce(prev, next) {
  const seen = new Set(prev.messages.map((m) => m.id));
  const watching = document.visibilityState === 'visible' && document.hasFocus();
  for (const m of next.messages) {
    if (seen.has(m.id) || m.system || m.authorId === next.me) continue;
    if (watching && ui.view === 'chat' && ui.channelId === m.channelId) continue;
    const c = channel(m.channelId);
    notify(`${member(m.authorId).name} · # ${c ? c.name : ''}`, m.text.slice(0, 120) || '파일을 보냈어요');
  }
  const old = new Map(prev.tasks.map((t) => [t.id, t]));
  for (const t of next.tasks) {
    const o = old.get(t.id);
    if (!o) {
      if (t.assigneeId === next.me && t.createdBy !== next.me) notify('새 할 일을 받았어요', `${member(t.createdBy).name}님: ${t.title}`);
    } else if (o.status !== 'done' && t.status === 'done' && t.doneBy !== next.me && (t.createdBy === next.me || t.assigneeId === next.me)) {
      notify('할 일 완료', `${member(t.doneBy).name}님이 「${t.title}」을(를) 끝냈어요.`);
    }
  }
}

function unread(channelId) {
  const since = state.lastRead[channelId] || 0;
  return state.messages.filter((m) => m.channelId === channelId && m.authorId !== state.me && m.ts > since).length;
}
function markRead(channelId) {
  if (document.visibilityState !== 'visible' || !unread(channelId)) return;
  state.lastRead[channelId] = Math.max(...state.messages.filter((m) => m.channelId === channelId).map((m) => m.ts));
  server.markRead(channelId).catch(() => {});
}
function syncBadge() {
  const total = state ? state.channels.reduce((n, c) => n + unread(c.id), 0) : 0;
  document.title = total ? `(${total}) ELPA` : 'ELPA';
  native('set_unread', { count: total });
}

/* ---------- auth screen ---------- */
function showAuth() {
  state = null;
  noteDraft = null;
  if (stream) { sb.removeChannel(stream); stream = null; }
  $('#app').hidden = true;
  $('#auth').hidden = false;
  renderAuth();
  syncBadge();
}
function showApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  connect();
}
function renderAuth() {
  const signup = ui.authMode === 'signup';
  const team = ui.authMode === 'team'; // signed in, but no name/team yet
  const join = ui.teamMode === 'join';
  $('#auth').innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="brand"><span class="brand-mark">✓</span>ELPA</div>
      <p class="sub">${team ? '마지막 단계예요. 이름과 팀을 정해 주세요.' : '대화에서 요청한 일이 바로 할 일이 됩니다.'}</p>
      ${team ? '' : `<div class="tabs">
        <button type="button" data-action="auth-mode" data-id="login" aria-pressed="${!signup}">로그인</button>
        <button type="button" data-action="auth-mode" data-id="signup" aria-pressed="${signup}">가입하기</button>
      </div>`}
      ${signup || team ? '<label>이름<input name="name" required maxlength="30" autocomplete="name"></label>' : ''}
      ${team ? '' : `<label>이메일<input name="email" type="email" required autocomplete="email"></label>
      <label>비밀번호${signup ? ' (8자 이상)' : ''}<input name="password" type="password" required minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>`}
      ${signup || team ? `<div class="tabs small">
        <button type="button" data-action="team-mode" data-id="new" aria-pressed="${!join}">새 팀 만들기</button>
        <button type="button" data-action="team-mode" data-id="join" aria-pressed="${join}">초대 코드로 참여</button>
      </div>
      <label>${join ? '초대 코드' : '팀 이름'}<input name="team" required maxlength="40" autocomplete="off"></label>` : ''}
      <p class="form-error" role="alert" id="auth-error">${esc(ui.notice || '')}</p>
      <button class="btn primary" type="submit">${team ? '시작하기' : signup ? '가입하고 시작하기' : '로그인'}</button>
      ${team ? '<button type="button" class="btn" data-action="logout">다른 계정으로 로그인</button>' : ''}
    </form>`;
  ui.notice = '';
}

/* ---------- rendering ---------- */
function dueLabel(t) {
  if (!t.due) return '';
  const d = new Date(`${t.due}T00:00`);
  const late = t.status !== 'done' && t.due < ymd(new Date());
  return `<span class="due${late ? ' late' : ''}">${late ? '지남 · ' : ''}${d.getMonth() + 1}월 ${d.getDate()}일</span>`;
}

function renderSidebar() {
  const myOpen = state.tasks.filter((t) => t.assigneeId === state.me && t.status !== 'done').length;
  const channels = state.channels.map((c) => {
    const n = unread(c.id);
    const current = ui.view === 'chat' && ui.channelId === c.id;
    return `<button class="nav-item" data-action="open-channel" data-id="${c.id}"${current ? ' aria-current="page"' : ''}>
      <span class="glyph">#</span><span class="name">${esc(c.name)}</span>${n ? `<span class="count" aria-label="안 읽은 메시지 ${n}개">${n}</span>` : ''}</button>`;
  }).join('');
  const me = member(state.me);
  $('#sidebar').innerHTML = `
    <div class="brand"><span class="brand-mark">✓</span>ELPA</div>
    <div class="nav-label"><span>대화</span><button data-action="channel-add" aria-label="대화방 추가" title="대화방 추가">+</button></div>
    ${channels}
    ${ui.addingChannel ? '<input class="channel-new" id="channel-new" placeholder="대화방 이름 입력 후 Enter" maxlength="30" aria-label="새 대화방 이름">' : ''}
    <div class="nav-label"><span>도구</span></div>
    <button class="nav-item" data-action="open-view" data-id="board"${ui.view === 'board' ? ' aria-current="page"' : ''}>
      <span class="glyph">☑</span><span class="name">할 일</span>${myOpen ? `<span class="count quiet" aria-label="내 진행 중인 할 일 ${myOpen}개">${myOpen}</span>` : ''}</button>
    <button class="nav-item" data-action="open-view" data-id="notes"${ui.view === 'notes' ? ' aria-current="page"' : ''}>
      <span class="glyph">✎</span><span class="name">노트</span></button>
    <div class="me">
      <div class="me-row">${avatar(me)}<div class="me-text"><b>${esc(me.name)}</b><span>${esc(state.team.name)} · ${state.members.length}명</span></div></div>
      <button class="btn sm" data-action="copy-invite" title="팀원에게 이 코드를 알려주세요">초대 코드 ${esc(state.team.inviteCode)} 복사</button>
      <button class="btn sm" data-action="logout">로그아웃</button>
    </div>`;
}

function taskChip(t) {
  return `<button class="task-chip${t.status === 'done' ? ' done' : ''}" data-action="task-open" data-id="${t.id}">
    <span class="pill ${t.status}">${STATUS[t.status]}</span><span class="t">${esc(t.title)}</span>${avatar(member(t.assigneeId), true)}${dueLabel(t)}</button>`;
}

/* ---------- attachments ---------- */
function fileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
function attachmentsHtml(m) {
  const list = m.attachments || [];
  if (!list.length) return '';
  return `<div class="atts">${list.map((a) => (INLINE_IMAGES.includes(a.type)
    ? `<button class="att-img" data-action="att-open" data-path="${esc(a.path)}" title="${esc(a.name)} · 눌러서 크게 보기"><img alt="${esc(a.name)}" data-img="${esc(a.path)}"></button>`
    : `<button class="att-file" data-action="att-open" data-path="${esc(a.path)}" data-name="${esc(a.name)}"><span class="att-name">${esc(a.name)}</span><span class="att-size">${fileSize(a.size)} · 내려받기</span></button>`)).join('')}</div>`;
}
// Images sit in a private bucket: fetch a short-lived link for each one on screen.
function loadImages() {
  document.querySelectorAll('img[data-img]:not([src])').forEach((img) => {
    const path = img.dataset.img;
    if (!imageUrls.has(path)) imageUrls.set(path, server.signedUrl(path).catch(() => { imageUrls.delete(path); return null; }));
    imageUrls.get(path).then((url) => { if (url) img.src = url; else img.alt = '이미지를 불러오지 못했어요'; });
  });
}
function renderPending() {
  const box = $('#pending');
  if (!box) return;
  box.innerHTML = pending.map((f, i) => `<span class="pending-file"><span class="att-name">${esc(f.name)}</span><span class="att-size">${fileSize(f.size)}</span>
    <button type="button" data-action="att-remove" data-id="${i}" aria-label="${esc(f.name)} 첨부 취소">×</button></span>`).join('');
}
function addFiles(files) {
  for (const f of files) {
    if (pending.length >= MAX_FILES) { toast('파일은 한 번에 5개까지예요', '나머지는 다음 메시지로 보내 주세요.'); break; }
    if (f.size > MAX_FILE_BYTES) { toast('파일이 너무 커요', `${f.name}: 한 개에 20MB까지 보낼 수 있어요.`); continue; }
    if (!f.size) continue;
    pending.push(f);
  }
  renderPending();
}

function renderChat(scroll) {
  const c = channel(ui.channelId);
  if (!c) { $('#main').innerHTML = '<p class="empty">대화방이 없어요.</p>'; return; }
  const msgs = state.messages.filter((m) => m.channelId === c.id);
  let lastDay = '';
  const body = msgs.map((m) => {
    const d = new Date(m.ts);
    const day = ymd(d);
    const sep = day !== lastDay ? `<div class="day">${dayFmt.format(d)}</div>` : '';
    lastDay = day;
    if (m.system) return `${sep}<div class="system" id="m-${m.id}"><span class="tick">✓</span>${esc(m.text)}</div>`;
    const a = member(m.authorId);
    const t = m.taskId && task(m.taskId);
    return `${sep}<div class="msg${ui.flashId === m.id ? ' flash' : ''}" id="m-${m.id}">${avatar(a)}
      <div class="msg-body"><div class="msg-meta"><b>${esc(a.name)}</b><time>${timeFmt.format(d)}</time></div>
        ${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ''}${attachmentsHtml(m)}${t ? taskChip(t) : ''}</div>
      ${t ? '' : `<div class="msg-tools"><button class="btn" data-action="task-from-msg" data-id="${m.id}">할 일로 만들기</button></div>`}</div>`;
  }).join('');
  $('#main').innerHTML = `
    <header class="head"><h1># ${esc(c.name)}</h1><span class="sub">멤버 ${state.members.length}명</span></header>
    <div class="messages" id="messages">${body || '<p class="empty">아직 메시지가 없어요. 첫 메시지를 남겨보세요.</p>'}</div>
    <div class="pending" id="pending"></div>
    <form class="composer" id="composer-form">
      <button class="btn attach" type="button" data-action="att-pick" aria-label="파일 첨부" title="파일 첨부 (끌어다 놓아도 돼요)">＋</button>
      <input type="file" id="file-input" multiple hidden>
      <textarea id="composer" placeholder="${esc(c.name)}에 메시지 보내기 (Enter로 전송, Shift+Enter로 줄바꿈)" aria-label="메시지 입력" maxlength="4000"></textarea>
      <button class="btn primary" type="submit">보내기</button></form>`;
  renderPending();
  loadImages();
  const list = $('#messages');
  const target = ui.flashId && document.getElementById(`m-${ui.flashId}`);
  if (target) target.scrollIntoView({ block: 'center' });
  else if (scroll && !scroll.atBottom) list.scrollTop = scroll.top; // reading older messages: stay put
  else list.scrollTop = list.scrollHeight;
  ui.flashId = null;
  ui.renderedChannel = c.id;
  markRead(c.id);
}

function renderBoard() {
  const visible = state.tasks.filter((t) => !ui.mineOnly || t.assigneeId === state.me);
  const cols = Object.keys(STATUS).map((s) => {
    const items = visible.filter((t) => t.status === s).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    const cards = items.map((t) => `<button class="card${s === 'done' ? ' done' : ''}" draggable="true" data-action="task-open" data-id="${t.id}">
        <div class="title">${esc(t.title)}</div>
        <div class="foot">${avatar(member(t.assigneeId), true)}<span>${esc(member(t.assigneeId).name)}</span>${dueLabel(t)}
          ${t.channelId && channel(t.channelId) ? `<span class="from"># ${esc(channel(t.channelId).name)}</span>` : ''}</div></button>`).join('');
    const quick = s === 'todo' ? '<form class="quick-add" id="quick-add"><input id="quick-title" name="title" placeholder="새 할 일 입력 후 Enter" maxlength="120" aria-label="새 할 일" autocomplete="off"><button class="btn" type="submit">추가</button></form>' : '';
    return `<section class="col" data-status="${s}"><h2><span class="pill ${s}">${STATUS[s]}</span><span class="sub">${items.length}</span></h2>${quick}${cards || '<p class="empty">비어 있어요</p>'}</section>`;
  }).join('');
  $('#main').innerHTML = `
    <header class="head"><h1>할 일</h1><span class="sub">카드를 끌어서 단계를 옮기세요</span><span class="spacer"></span>
      <label class="toggle"><input type="checkbox" id="mine-only"${ui.mineOnly ? ' checked' : ''}>내 할 일만</label>
      <button class="btn primary" data-action="task-new">새 할 일</button></header>
    <div class="board">${cols}</div>`;
}

const sortedNotes = () => [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt);
function noteListHtml() {
  return sortedNotes().map((n) => `<button class="note-item" data-action="note-open" data-id="${n.id}" aria-current="${n.id === ui.noteId}">
    <b>${esc(n.title || '제목 없음')}</b><span>${dayFmt.format(new Date(n.updatedAt))}</span></button>`).join('') || '<p class="empty">노트가 없어요</p>';
}

function renderNotes() {
  if (!state.notes.some((n) => n.id === ui.noteId)) ui.noteId = state.notes.length ? sortedNotes()[0].id : null;
  const n = state.notes.find((x) => x.id === ui.noteId);
  $('#main').innerHTML = `
    <header class="head"><h1>노트</h1><span class="sub">팀이 함께 보는 노트 · 입력하면 바로 저장돼요</span><span class="spacer"></span>
      <button class="btn primary" data-action="note-new">새 노트</button></header>
    <div class="notes"><nav class="note-list" id="note-list">${noteListHtml()}</nav>
      ${n ? `<div class="note-edit"><input id="note-title" value="${esc(n.title)}" placeholder="제목" aria-label="노트 제목" maxlength="80">
        <textarea id="note-body" placeholder="내용을 적어보세요" aria-label="노트 내용" maxlength="50000">${esc(n.body)}</textarea>
        <div class="note-foot"><span class="spacer"></span><button class="btn danger" data-action="note-delete">노트 삭제</button></div></div>`
    : '<div class="note-edit"><p class="empty">왼쪽에서 노트를 고르거나 새 노트를 만들어 보세요.</p></div>'}</div>`;
}

// Re-rendering replaces the DOM, so carry typed text, focus and scroll position across it.
const KEEP = ['composer', 'note-title', 'note-body', 'quick-title', 'channel-new'];
function render() {
  if (!state) return;
  const active = document.activeElement;
  const focus = active && KEEP.includes(active.id) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  const typed = {};
  for (const id of ['composer', 'quick-title', 'channel-new']) { const el = document.getElementById(id); if (el) typed[id] = el.value; }
  const list = $('#messages');
  const sameChannel = ui.view === 'chat' && ui.renderedChannel === ui.channelId;
  const scroll = list && sameChannel ? { top: list.scrollTop, atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 40 } : null;
  if (!sameChannel) delete typed.composer;

  if (ui.view === 'chat') renderChat(scroll);
  else if (ui.view === 'board') renderBoard();
  else renderNotes();
  if (ui.view !== 'chat') ui.renderedChannel = null;
  renderSidebar();
  syncBadge();

  for (const [id, value] of Object.entries(typed)) { const el = document.getElementById(id); if (el) el.value = value; }
  const el = focus && document.getElementById(focus.id);
  if (el) { el.focus(); try { el.setSelectionRange(focus.start, focus.end); } catch (e) { /* not a text field */ } }
}

/* ---------- notes: save shortly after typing stops ---------- */
async function flushNote() {
  const d = noteDraft;
  if (!d) return;
  clearTimeout(d.timer);
  const sent = { title: d.title, body: d.body };
  try {
    await server.saveNote(d.id, sent.title, sent.body);
  } catch (e) {
    toast('노트를 저장하지 못했어요', e.message);
    return;
  }
  if (noteDraft === d && d.title === sent.title && d.body === sent.body) noteDraft = null;
}

/* ---------- task dialog ---------- */
function openTaskDialog(opts) {
  if (!state) return;
  const dlg = $('#task-dialog');
  const form = $('#task-form');
  const t = opts.taskId ? task(opts.taskId) : null;
  ui.dialog = opts;
  $('#task-dialog-title').textContent = t ? '할 일 수정' : '새 할 일';
  form.elements.assigneeId.innerHTML = state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  form.elements.title.value = t ? t.title : (opts.title || '');
  form.elements.assigneeId.value = t ? t.assigneeId : state.me;
  form.elements.due.value = t ? (t.due || '') : '';
  form.elements.status.value = t ? t.status : 'todo';
  $('#task-delete').hidden = !t;
  const messageId = t ? t.messageId : opts.messageId;
  const origin = messageId && state.messages.find((m) => m.id === messageId);
  const originEl = $('#task-origin');
  originEl.hidden = !origin;
  if (origin) {
    originEl.innerHTML = `${esc(member(origin.authorId).name)}: “${esc((origin.text || (origin.attachments[0] || {}).name || '').slice(0, 90))}”${t ? ` <button type="button" data-action="task-jump" data-id="${origin.id}">대화에서 보기</button>` : ''}`;
  }
  if (!dlg.open) dlg.showModal();
  form.elements.title.focus();
  form.elements.title.select();
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'auth-mode': ui.authMode = id; renderAuth(); break;
    case 'team-mode': ui.teamMode = id; renderAuth(); break;
    case 'logout':
      await flushNote();
      await sb.auth.signOut().catch(() => {});
      ui.authMode = 'login';
      showAuth();
      break;
    case 'copy-invite':
      try { await navigator.clipboard.writeText(state.team.inviteCode); toast('초대 코드를 복사했어요', '가입 화면의 "초대 코드로 참여"에 붙여 넣으면 돼요.'); }
      catch (err) { toast('초대 코드', state.team.inviteCode); }
      break;
    case 'open-channel': flushNote(); ui.view = 'chat'; ui.channelId = id; render(); break;
    case 'open-view': flushNote(); ui.view = id; render(); break;
    case 'channel-add': ui.addingChannel = !ui.addingChannel; renderSidebar(); if (ui.addingChannel) $('#channel-new').focus(); break;
    case 'task-from-msg': {
      const m = state.messages.find((x) => x.id === id);
      openTaskDialog({ messageId: m.id, title: (m.text || (m.attachments[0] || {}).name || '').replace(/\s+/g, ' ').slice(0, 80) });
      break;
    }
    case 'att-pick': $('#file-input').click(); break;
    case 'att-remove': pending.splice(Number(id), 1); renderPending(); break;
    case 'att-open': {
      // Open the tab first (inside the click) so the browser does not block it as a pop-up.
      const tab = tauri ? null : window.open('about:blank', '_blank');
      try {
        const url = await server.signedUrl(el.dataset.path, el.dataset.name);
        if (tab) tab.location = url;
        else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.click(); }
      } catch (err) {
        if (tab) tab.close();
        toast('파일을 열지 못했어요', err.message);
      }
      break;
    }
    case 'task-new': openTaskDialog({}); break;
    case 'task-open': openTaskDialog({ taskId: id }); break;
    case 'task-cancel': $('#task-dialog').close(); break;
    case 'task-delete': $('#task-dialog').close(); act(() => server.deleteTask(ui.dialog.taskId)); break;
    case 'task-jump': {
      const m = state.messages.find((x) => x.id === id);
      $('#task-dialog').close();
      ui.view = 'chat'; ui.channelId = m.channelId; ui.flashId = m.id;
      render();
      break;
    }
    case 'note-open': flushNote(); ui.noteId = id; renderNotes(); break;
    case 'note-new': {
      await flushNote();
      const created = await act(() => server.addNote());
      if (created) { ui.noteId = created.id; renderNotes(); $('#note-title').focus(); }
      break;
    }
    case 'note-delete': { const id = ui.noteId; noteDraft = null; act(() => server.deleteNote(id)); break; }
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'auth-form') {
    e.preventDefault();
    const f = form.elements;
    const join = ui.teamMode === 'join';
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      triedSignupDetails = false;
      if (ui.authMode === 'team') {
        await server.joinTeam(f.name.value, join ? '' : f.team.value, join ? f.team.value : '');
      } else if (ui.authMode === 'signup') {
        const details = { name: f.name.value.trim(), teamName: join ? '' : f.team.value.trim(), inviteCode: join ? f.team.value.trim() : '' };
        const options = { data: details };
        if (!tauri) options.emailRedirectTo = location.origin + location.pathname;
        const result = await call(sb.auth.signUp({ email: f.email.value.trim(), password: f.password.value, options }));
        if (!result.session) { // the project requires confirming the email address first
          ui.authMode = 'login';
          ui.notice = '인증 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해 주세요.';
          renderAuth();
          return;
        }
      } else {
        await call(sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value }));
      }
      await refresh();
      if (!tauri && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    } catch (err) {
      button.disabled = false;
      const box = $('#auth-error');
      if (box) box.textContent = err.message;
    }
  } else if (form.id === 'composer-form') {
    e.preventDefault();
    const box = $('#composer');
    const text = box.value.trim();
    const files = pending;
    if (!text && !files.length) return;
    box.value = '';
    pending = [];
    renderPending();
    const channelId = ui.channelId;
    if (files.length) toast('파일을 올리는 중이에요', `${files.length}개`);
    const sent = await act(async () => {
      const attachments = [];
      for (const f of files) attachments.push(await server.upload(f));
      return server.post(channelId, text, attachments);
    });
    if (!sent) { // give the text and files back on failure
      if ($('#composer') && !$('#composer').value) $('#composer').value = text;
      pending = files.concat(pending).slice(0, MAX_FILES);
      renderPending();
    } else if ($('#messages')) $('#messages').scrollTop = $('#messages').scrollHeight;
  } else if (form.id === 'quick-add') {
    e.preventDefault();
    const input = form.elements.title;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    act(() => server.createTask({ title, assigneeId: state.me }));
  } else if (form.id === 'task-form') {
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title) { e.preventDefault(); f.title.focus(); return; }
    const fields = { title, assigneeId: f.assigneeId.value, due: f.due.value, status: f.status.value };
    const d = ui.dialog;
    if (d.taskId) act(() => server.updateTask(d.taskId, fields));
    else act(() => server.createTask({ ...fields, messageId: d.messageId }));
  }
});

document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'composer' && !e.shiftKey) {
    e.preventDefault();
    $('#composer-form').requestSubmit();
  } else if (e.target.id === 'channel-new') {
    const name = e.target.value.trim();
    if (!name) return;
    e.target.value = '';
    ui.addingChannel = false;
    const created = await act(() => server.addChannel(name));
    if (created) { ui.view = 'chat'; ui.channelId = created.id; render(); }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Escape' && e.target.id === 'channel-new') { ui.addingChannel = false; renderSidebar(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'note-title' && e.target.id !== 'note-body') return;
  const n = state.notes.find((x) => x.id === ui.noteId);
  if (!n) return;
  n.title = $('#note-title').value;
  n.body = $('#note-body').value;
  n.updatedAt = Date.now();
  if (!noteDraft || noteDraft.id !== n.id) noteDraft = { id: n.id };
  noteDraft.title = n.title;
  noteDraft.body = n.body;
  clearTimeout(noteDraft.timer);
  noteDraft.timer = setTimeout(flushNote, 600);
  $('#note-list').innerHTML = noteListHtml();
});

/* attach files: picker, paste, or drop onto the chat */
const hasFiles = (e) => !dragId && ui.view === 'chat' && state && e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  if (e.target.id === 'composer' && e.clipboardData && e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'file-input') { addFiles(e.target.files); e.target.value = ''; return; }
  if (e.target.id === 'mine-only') { ui.mineOnly = e.target.checked; renderBoard(); }
});

/* drag and drop between board columns */
let dragId = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest && e.target.closest('.card');
  if (!card) return;
  dragId = card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  card.classList.add('dragging');
});
document.addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.dragging, .over').forEach((el) => el.classList.remove('dragging', 'over'));
});
document.addEventListener('dragover', (e) => {
  const col = dragId && e.target.closest && e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.col.over').forEach((el) => el !== col && el.classList.remove('over'));
  col.classList.add('over');
});
document.addEventListener('drop', (e) => {
  const col = dragId && e.target.closest && e.target.closest('.col');
  if (!col) return;
  e.preventDefault();
  const t = task(dragId);
  dragId = null;
  const status = col.dataset.status;
  if (t && t.status !== status) act(() => server.updateTask(t.id, { status }));
});

document.addEventListener('visibilitychange', () => {
  if (!state || document.visibilityState !== 'visible') return;
  if (ui.view === 'chat' && ui.channelId) { markRead(ui.channelId); renderSidebar(); syncBadge(); }
  refresh().catch(() => {}); // in case live updates were missed while the tab slept
});
window.addEventListener('pagehide', () => { flushNote(); });

/* desktop shell: tray menu "새 할 일" */
if (tauri) tauri.event.listen('quick-add', () => openTaskDialog({}));

// Session ended elsewhere (another tab signed out, or the login expired).
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && state) setTimeout(() => { ui.authMode = 'login'; showAuth(); }, 0);
});

refresh().catch((e) => { if (!state) { ui.notice = e.message; showAuth(); } });
