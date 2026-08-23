'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const G = {
  me: null, token: null, view: 'login', detailId: null, compFilter: 'ALL', commentPoll: null,
  tf: { search: '', status: '', priority: '', assignee: '', overdue: false, thisweek: false },
  mf: { search: '', status: '', priority: '' },
  _teamTasks: [], _myTasks: [], _archivedTasks: [], _selectedIds: new Set(), _archivedIds: new Set(), _dashFilter: null,
};

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (G.token) opts.headers['Authorization'] = `Bearer ${G.token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch('/api' + path, opts);
  if (r.status === 401) { doLogout(); return null; }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── Utility helpers ───────────────────────────────────────────────────────────
const TODAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

function fmt(d) {
  if (!d) return '—';
  return new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtLong(d) {
  return new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function isOverdue(t) {
  return t.due_date && t.due_date.slice(0, 10) < TODAY() &&
         !['completed', 'cancelled'].includes(t.status);
}

function taskPct(t) {
  const o = t.objectives || [];
  return o.length ? Math.round(100 * o.filter(x => x.done).length / o.length) : 0;
}

function initials(name) {
  return (name || '').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function collabAvatarStack(collaborators) {
  if (!collaborators || !collaborators.length) return '';
  const visible = collaborators.slice(0, 3);
  const extra   = collaborators.length - 3;
  return `<div class="collab-stack">
    ${visible.map(c => `<div class="collab-av" title="${esc(c.name)}">${initials(c.name)}</div>`).join('')}
    ${extra > 0 ? `<div class="collab-av collab-av-extra">+${extra}</div>` : ''}
  </div>`;
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function userColor(userId) {
  const PALETTE = [
    '#1a6fa8', '#0d7d6b', '#6b4fa8', '#c25c00',
    '#2e7d32', '#b5174a', '#00838f', '#6d4c41',
    '#4527a0', '#558b2f', '#c07700', '#ad1457',
  ];
  return PALETTE[(userId || 0) % PALETTE.length];
}

// ── Task filtering ────────────────────────────────────────────────────────────
function applyTaskFilters(tasks, f) {
  let out = tasks;
  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.code  || '').toLowerCase().includes(q) ||
      (t.assignee_name || '').toLowerCase().includes(q)
    );
  }
  if (f.status)   out = out.filter(t => t.status   === f.status);
  if (f.priority) out = out.filter(t => t.priority  === f.priority);
  if (f.assignee) out = out.filter(t => String(t.assignee_id) === String(f.assignee));
  if (f.overdue)  out = out.filter(t => isOverdue(t));
  if (f.thisweek) {
    const tod = TODAY();
    const d7  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    out = out.filter(t => t.due_date &&
      t.due_date.slice(0, 10) >= tod &&
      t.due_date.slice(0, 10) <= d7 &&
      !['completed', 'cancelled'].includes(t.status));
  }
  return out;
}

const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-soft);pointer-events:none"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

function teamFilterBarHtml(assignees) {
  const f = G.tf;
  const hasFilter = f.search || f.status || f.priority || f.assignee || f.overdue || f.thisweek;
  return `
  <div class="filter-bar">
    <div class="search-wrap">
      ${SEARCH_ICON}
      <input class="search-input" type="text" placeholder="Search by title, code or name…"
             value="${esc(f.search)}" oninput="G.tf.search=this.value;updateTeamTable()">
    </div>
    <select onchange="G.tf.status=this.value;updateTeamTable()">
      <option value="">All statuses</option>
      ${['not_started','in_progress','blocked','completed','cancelled'].map(s =>
        `<option value="${s}" ${f.status===s?'selected':''}>${ST_LABEL[s]||s}</option>`).join('')}
    </select>
    <select onchange="G.tf.priority=this.value;updateTeamTable()">
      <option value="">All priorities</option>
      ${['high','medium','low'].map(p =>
        `<option value="${p}" ${f.priority===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}
    </select>
    <select onchange="G.tf.assignee=this.value;updateTeamTable()">
      <option value="">All employees</option>
      ${assignees.map(a => `<option value="${a.id}" ${String(f.assignee)===String(a.id)?'selected':''}>${esc(a.name)}</option>`).join('')}
    </select>
    ${hasFilter ? `<button class="btn btn-ghost btn-sm" onclick="clearTeamFilters()">Clear</button>` : ''}
  </div>`;
}

function myFilterBarHtml() {
  const f = G.mf;
  const hasFilter = f.search || f.status || f.priority;
  return `
  <div class="filter-bar">
    <div class="search-wrap">
      ${SEARCH_ICON}
      <input class="search-input" type="text" placeholder="Search by title or code…"
             value="${esc(f.search)}" oninput="G.mf.search=this.value;updateMyTable()">
    </div>
    <select onchange="G.mf.status=this.value;updateMyTable()">
      <option value="">All statuses</option>
      ${['not_started','in_progress','blocked','completed','cancelled'].map(s =>
        `<option value="${s}" ${f.status===s?'selected':''}>${ST_LABEL[s]||s}</option>`).join('')}
    </select>
    <select onchange="G.mf.priority=this.value;updateMyTable()">
      <option value="">All priorities</option>
      ${['high','medium','low'].map(p =>
        `<option value="${p}" ${f.priority===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}
    </select>
    ${hasFilter ? `<button class="btn btn-ghost btn-sm" onclick="clearMyFilters()">Clear</button>` : ''}
  </div>`;
}

function clearTeamFilters() {
  G.tf = { search: '', status: '', priority: '', assignee: '', overdue: false, thisweek: false };
  drawTeamPage();
}

function dashFilter(type) {
  const f = { search: '', status: '', priority: '', assignee: '', overdue: false, thisweek: false };
  if (type === 'overdue')  f.overdue  = true;
  if (type === 'blocked')  f.status   = 'blocked';
  if (type === 'thisweek') f.thisweek = true;
  G._dashFilter = f;
  go('team');
}

function clearMyFilters() {
  G.mf = { search: '', status: '', priority: '' };
  drawMyPage();
}

function updateTeamTable() {
  const el = document.getElementById('team-table');
  if (!el) return;
  const filtered  = applyTaskFilters(G._teamTasks, G.tf);
  const hasFilter = G.tf.search || G.tf.status || G.tf.priority || G.tf.assignee;
  const bulkBar   = G._selectedIds.size > 0 ? `
    <div id="bulk-bar" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--accent-s);border-radius:8px;margin-bottom:12px;border:1px solid #b8daf2;flex-wrap:wrap">
      <span style="font-size:13.5px;font-weight:600">${G._selectedIds.size} task${G._selectedIds.size > 1 ? 's' : ''} selected</span>
      <button class="btn btn-sm" style="color:var(--red);border-color:var(--red)" onclick="archiveSelected()">Archive selected</button>
      <button class="btn btn-ghost btn-sm" onclick="clearSelection()">Clear selection</button>
    </div>` : '';
  el.innerHTML = bulkBar + (hasFilter
    ? `<div class="muted small" style="margin-bottom:10px">${filtered.length} of ${G._teamTasks.length} tasks</div>`
    : '') + taskTable(filtered, true);
}

function updateMyTable() {
  const el = document.getElementById('my-table');
  if (!el) return;
  const base = G._myTaskTab === 'assignedby'
    ? G._myTasks.filter(t => t.created_by === G.me.id && t.assignee_id !== G.me.id)
    : G._myTasks;
  const filtered  = applyTaskFilters(base, G.mf);
  const hasFilter = G.mf.search || G.mf.status || G.mf.priority;
  el.innerHTML = (hasFilter
    ? `<div class="muted small" style="margin-bottom:10px">${filtered.length} of ${base.length} tasks</div>`
    : '') + taskTable(filtered, G._myTaskTab === 'assignedby');
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ── Chips ──────────────────────────────────────────────────────────────────────
const ST_LABEL = {
  in_progress: 'In progress', not_started: 'Not started',
  blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled',
};

function codeChip(t) {
  const empCreated = t.created_by_role === 'employee';
  return `<span class="code ${empCreated ? 'emp-task' : (t.company || '').toLowerCase()}">${esc(t.code)}</span>`;
}
function prPill(t) {
  const p = t.priority || 'low';
  return `<span class="pill p-${p}">${p[0].toUpperCase() + p.slice(1)}</span>`;
}
function stPill(t) {
  return `<span class="pill s-${t.status}">${ST_LABEL[t.status] || t.status}</span>`;
}
function progressColor(t) {
  if (t.status === 'completed') return 'var(--green)';
  if (t.status === 'blocked')   return 'var(--red)';
  return 'var(--accent)';
}

function duePill(t) {
  if (!t.due_date) return '<span class="due">No deadline</span>';
  const od = isOverdue(t);
  return `<span class="due${od ? ' over' : ''}">${od ? '⚠ ' : ''}${fmt(t.due_date)}</span>`;
}

// ── Dashboard compact task list ────────────────────────────────────────────────
function dashTaskList(tasks) {
  if (!tasks.length) return '<div class="empty">None</div>';
  return tasks.map(t => `
    <div class="dash-task-row" onclick="openTask(${t.id})">
      <div class="dash-task-left">
        ${codeChip(t)}
        <div class="dash-task-info">
          <div class="dash-task-title">${esc(t.title)}</div>
          <div class="dash-task-sub">${esc(t.assignee_name || '—')} · ${esc(t.assignee_dept || '')}</div>
        </div>
      </div>
      <div class="dash-task-right">
        ${stPill(t)}
        ${duePill(t)}
      </div>
    </div>`).join('');
}

// ── Task table ─────────────────────────────────────────────────────────────────
function taskTable(tasks, showWho) {
  if (!tasks.length) return '<div class="empty">No tasks found</div>';
  const allChecked = tasks.length > 0 && tasks.every(t => G._selectedIds.has(t.id));
  return `<div class="table-wrap"><table>
    <thead><tr>
      ${showWho ? `<th style="width:36px;text-align:center"><input type="checkbox" ${allChecked ? 'checked' : ''} title="Select all" onchange="toggleAllCheck(this.checked)"></th>` : ''}
      <th>Task ID</th><th>Task</th>
      ${showWho ? '<th>Assigned to</th>' : ''}
      <th>Priority</th><th>Status</th><th>Deadline</th><th>Progress</th>
    </tr></thead>
    <tbody>
    ${tasks.map(t => `<tr class="click${t.created_by_role === 'employee' ? ' emp-task-row' : ''}" onclick="openTask(${t.id})">
      ${showWho ? `<td style="text-align:center" onclick="event.stopPropagation()">
        <input type="checkbox" class="task-chk" value="${t.id}" ${G._selectedIds.has(t.id) ? 'checked' : ''}
          onchange="toggleTaskCheck(${t.id}, this.checked)">
      </td>` : ''}
      <td>${codeChip(t)}</td>
      <td class="task-title">${esc(t.title)}${!showWho && t.assignee_id !== G.me.id ? ' <span class="collab-badge">Collaborating</span>' : ''}</td>
      ${showWho ? `<td><span style="font-weight:500">${esc(t.assignee_name || '—')}</span><br>
        <span class="small muted">${esc(t.assignee_dept || '')}</span>
        ${(t.collaborators || []).length ? collabAvatarStack(t.collaborators) : ''}</td>` : ''}
      <td>${prPill(t)}</td>
      <td>${stPill(t)}</td>
      <td>${duePill(t)}</td>
      <td><div style="display:flex;align-items:center;gap:7px"><div class="progress" style="flex:1"><i style="width:${taskPct(t)}%;background:${progressColor(t)}"></i></div><span style="font-size:12px;font-weight:600;color:var(--ink);min-width:32px;text-align:right">${taskPct(t)}%</span></div></td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

// ── Auth ───────────────────────────────────────────────────────────────────────
async function doLogin(e) {
  e.preventDefault();
  const email = document.getElementById('l-email').value.trim();
  const pass  = document.getElementById('l-pass').value;
  const btn   = document.getElementById('l-btn');
  const err   = document.getElementById('l-err');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const result = await api('POST', '/auth/login', { email, password: pass });
    if (!result) { err.textContent = 'Incorrect email or password. Please try again.'; return; }
    const { token, user } = result;
    G.token = token;
    G.me    = user;
    localStorage.setItem('vv_token', token);
    initApp();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function doLogout() {
  G.token = null;
  G.me    = null;
  localStorage.removeItem('vv_token');
  document.getElementById('app').style.display          = 'none';
  document.getElementById('force-change').style.display = 'none';
  document.getElementById('login').style.display        = 'flex';
}

async function submitForceChange(e) {
  e.preventDefault();
  const pass    = document.getElementById('fc-pass').value;
  const confirm = document.getElementById('fc-confirm').value;
  const err     = document.getElementById('fc-err');
  const btn     = document.getElementById('fc-btn');
  err.textContent = '';
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }
  if (pass !== confirm) { err.textContent = 'Passwords do not match'; return; }
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  try {
    await api('POST', '/auth/force-change-password', { password: pass });
    G.me.must_change_password = false;
    initApp();
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled    = false;
    btn.textContent = 'Set password & continue';
  }
}

async function checkAuth() {
  if (location.hash.startsWith('#reset-')) {
    showResetForm(location.hash.slice(7));
    return;
  }
  const saved = localStorage.getItem('vv_token');
  if (!saved) return;
  G.token = saved;
  try {
    G.me = await api('GET', '/auth/me');
    if (G.me) initApp();
  } catch {
    G.token = null;
    localStorage.removeItem('vv_token');
  }
}

function showForgotForm() {
  document.querySelector('.login-card').innerHTML = `
    <h1 style="font-size:20px;margin-bottom:6px">Forgot password</h1>
    <div class="sub" style="margin-bottom:24px">Enter your email and we'll send you a reset link</div>
    <div class="fld">
      <label>Email address</label>
      <input id="fp-email" type="email" placeholder="your@email.com" autocomplete="email">
    </div>
    <div id="fp-msg" style="font-size:13px;margin-top:8px;min-height:18px"></div>
    <button class="btn btn-amber" style="width:100%;margin-top:6px;padding:12px 16px;font-size:14px" onclick="submitForgotPassword()">Send reset link</button>
    <button class="btn btn-ghost" style="width:100%;margin-top:8px" onclick="location.reload()">Back to sign in</button>
  `;
  document.getElementById('fp-email').focus();
}

async function submitForgotPassword() {
  const emailEl = document.getElementById('fp-email');
  const msg     = document.getElementById('fp-msg');
  if (!emailEl.value.trim()) {
    msg.style.color = 'var(--red)'; msg.textContent = 'Please enter your email'; return;
  }
  msg.style.color = 'var(--ink)'; msg.textContent = 'Sending…';
  try {
    await api('POST', '/auth/forgot-password', { email: emailEl.value.trim() });
    msg.style.color = 'var(--green)';
    msg.textContent = 'If this email exists, a reset link has been sent. Check your inbox.';
  } catch (e) {
    msg.style.color = 'var(--red)'; msg.textContent = e.message;
  }
}

function showResetForm(token) {
  document.getElementById('login').style.display = 'flex';
  document.getElementById('app').style.display   = 'none';
  document.querySelector('.login-card').innerHTML = `
    <h1 style="font-size:20px;margin-bottom:6px">Set new password</h1>
    <div class="sub" style="margin-bottom:24px">Enter a new password for your account</div>
    <div class="fld">
      <label>New password</label>
      <input id="rp-pass" type="password" placeholder="••••••••" minlength="6">
    </div>
    <div class="fld" style="margin-top:12px">
      <label>Confirm password</label>
      <input id="rp-pass2" type="password" placeholder="••••••••">
    </div>
    <div id="rp-msg" style="font-size:13px;margin-top:8px;min-height:18px;color:var(--red)"></div>
    <button class="btn btn-amber" style="width:100%;margin-top:6px;padding:12px 16px;font-size:14px" onclick="submitResetPassword('${token}')">Set new password</button>
  `;
  document.getElementById('rp-pass').focus();
}

async function submitResetPassword(token) {
  const pass  = document.getElementById('rp-pass').value;
  const pass2 = document.getElementById('rp-pass2').value;
  const msg   = document.getElementById('rp-msg');
  if (!pass || pass.length < 6) { msg.textContent = 'Password must be at least 6 characters'; return; }
  if (pass !== pass2)           { msg.textContent = 'Passwords do not match'; return; }
  msg.style.color = 'var(--ink)'; msg.textContent = 'Saving…';
  try {
    await api('POST', '/auth/reset-password', { token, password: pass });
    msg.style.color = 'var(--green)';
    msg.textContent = 'Password updated! Redirecting to sign in…';
    setTimeout(() => { location.hash = ''; location.reload(); }, 1800);
  } catch (e) {
    msg.style.color = 'var(--red)'; msg.textContent = e.message;
  }
}

function initApp() {
  if (G.me.must_change_password) {
    document.getElementById('login').style.display        = 'none';
    document.getElementById('app').style.display          = 'none';
    document.getElementById('force-change').style.display = 'flex';
    return;
  }
  document.getElementById('force-change').style.display = 'none';
  document.getElementById('login').style.display        = 'none';
  document.getElementById('app').style.display          = 'block';

  const adminViews = ['dashboard','team','assign','dailylogs','users','attendance','myday','password','editTask','archived'];
  const empViews   = G.me.attendance_enabled
    ? ['myday','mytasks','history','attendance','password']
    : ['myday','mytasks','history','password'];
  const validViews = G.me.role === 'admin' ? adminViews : empViews;
  const hash       = location.hash.slice(1);

  if (hash.startsWith('detail-')) {
    const id = parseInt(hash.slice(7), 10);
    if (id) { G.detailId = id; G.view = 'detail'; }
    else G.view = G.me.role === 'admin' ? 'dashboard' : 'myday';
  } else if (validViews.includes(hash)) {
    G.view = hash;
  } else {
    G.view = G.me.role === 'admin' ? 'dashboard' : 'myday';
  }

  updateHeader();
  renderNav();
  renderView();
  setupPush();
}

// ── Push notifications ─────────────────────────────────────────────────────────
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'granted') {
      await subscribePush();
    } else if (Notification.permission === 'default' && !sessionStorage.getItem('push_dismissed')) {
      showPushBanner();
    }
  } catch (e) { console.warn('[push]', e.message); }
}

function showPushBanner() {
  if (document.getElementById('push-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'push-banner';
  banner.innerHTML = `
    <span>🔔 Enable browser notifications for task alerts</span>
    <button onclick="enablePush()" class="btn btn-amber btn-sm" style="margin-left:12px">Enable</button>
    <button onclick="dismissPushBanner()" style="background:none;border:none;color:var(--ink-soft);font-size:18px;cursor:pointer;margin-left:8px;line-height:1">×</button>`;
  document.querySelector('.shell').prepend(banner);
}

function dismissPushBanner() {
  sessionStorage.setItem('push_dismissed', '1');
  const b = document.getElementById('push-banner');
  if (b) b.remove();
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  dismissPushBanner();
  if (perm === 'granted') await subscribePush();
}

async function subscribePush() {
  try {
    const sw  = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/vapid-key');
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await sw.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${G.token}` },
      body:    JSON.stringify(sub.toJSON()),
    });
  } catch (e) { console.warn('[push] subscribe:', e.message); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Header ─────────────────────────────────────────────────────────────────────
function updateHeader() {
  document.getElementById('hdr-name').textContent = G.me.name;
  document.getElementById('hdr-role').textContent = G.me.role === 'admin'
    ? 'Admin · Vertex + Vision'
    : `${G.me.department || ''} · ${G.me.company === 'VTX' ? 'Vertex Electronics' : G.me.company === 'VSN' ? 'Vision Engineering' : 'Vertex + Vision'}`;
  document.getElementById('hdr-av').textContent = initials(G.me.name);
  document.getElementById('hdr-date').textContent = ' · ' +
    new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function renderNav() {
  const adminItems = [
    ['dashboard', 'Dashboard'], ['team', 'Team tasks'],
    ['assign', 'Assign task'], ['dailylogs', 'Daily logs'],
    ['attendance', 'Attendance'], ['users', 'Manage users'],
    ['archived', 'Archived tasks'], ['myday', 'My day'],
    ['password', 'Change password'],
  ];
  const empItems = G.me.attendance_enabled
    ? [['myday', 'My day'], ['mytasks', 'My tasks'], ['empAssign', 'Assign task'],
       ['history', 'My history'], ['attendance', 'Attendance'], ['password', 'Change password']]
    : [['myday', 'My day'], ['mytasks', 'My tasks'], ['empAssign', 'Assign task'],
       ['history', 'My history'], ['password', 'Change password']];
  const items = G.me.role === 'admin' ? adminItems : empItems;
  const label = G.me.role === 'admin' ? 'Management' : 'Workspace';
  document.getElementById('nav').innerHTML =
    `<div class="navlabel">${label}</div>` +
    items.map(([v, l]) =>
      `<button class="${G.view === v ? 'active' : ''}" onclick="go('${v}')">${l}</button>`
    ).join('');
}

function toggleNav() {
  document.body.classList.toggle('nav-open');
}

function go(v, params = {}) {
  document.body.classList.remove('nav-open');
  stopCommentPolling();
  G.view = v;
  G.detailId = null;
  Object.assign(G, params);
  location.hash = v;
  renderNav();
  renderView();
}

function openTask(id) {
  G.detailId = id;
  G.view = 'detail';
  location.hash = 'detail-' + id;
  renderNav();
  renderView();
}

function openEditTask(id) {
  G.editTaskId = id;
  G.view = 'editTask';
  location.hash = 'editTask';
  renderNav();
  renderView();
}

// ── View dispatcher ────────────────────────────────────────────────────────────
function renderView() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading…</span></div>';
  const views = {
    myday:     renderMyDay,
    mytasks:   renderMyTasks,
    history:   renderHistory,
    dashboard: renderDashboard,
    team:      renderTeam,
    assign:    renderAssign,
    users:     renderUsers,
    empAssign: renderEmpAssign,
    detail:    () => renderDetail(G.detailId),
    editTask:  () => renderEditTask(G.editTaskId),
    password:  renderChangePassword,
    dailylogs:  renderDailyLogs,
    archived:   renderArchived,
    attendance: () => G.me.role === 'admin' ? renderAttendanceAdmin() : renderAttendance(),
  };
  const fn = views[G.view];
  if (fn) fn().catch(ex => {
    main.innerHTML = `<div class="error-msg">Failed to load: ${esc(ex.message)}</div>`;
  });
}

// ── MY DAY ─────────────────────────────────────────────────────────────────────
async function renderMyDay() {
  const main  = document.getElementById('main');
  const today = TODAY();
  const [myTasks, todayLogs] = await Promise.all([
    api('GET', '/tasks'),
    api('GET', `/logs?date=${today}&user_id=${G.me.id}`),
  ]);

  const pending = (myTasks || []).filter(t =>
    !['completed', 'cancelled'].includes(t.status)
  );
  const logs    = todayLogs || [];
  const opts    = pending.map(t =>
    `<option value="${t.id}">${esc(t.code)} — ${esc(t.title)}</option>`).join('');

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>My day</h1><div class="sub">${fmtLong(today)} · Log the work you've done today</div></div>
  </div>
  <div class="grid2">
    <div>
      <div class="card" style="margin-bottom:18px">
        <h2 style="margin-bottom:12px">Add log entry</h2>
        <form id="log-form" onsubmit="submitLog(event)">
          <div class="fld">
            <label>Task</label>
            <select id="f-task" onchange="toggleAdhocTitle()">
              <option value="">General Work</option>
              ${opts}
            </select>
          </div>
          <div class="fld" id="f-adhoc-wrap">
            <label>Task name</label>
            <input id="f-adhoc-title" placeholder="e.g. Prepare quotation for SNGPL…">
          </div>
          <div class="fld">
            <label>What did you do?</label>
            <textarea id="f-txt" rows="3" placeholder="Describe the work you did today…" required></textarea>
          </div>
          <div class="row">
            <div class="fld">
              <label>Hours spent</label>
              <input id="f-hrs" type="number" step="0.5" min="0.5" max="16" placeholder="2.5">
            </div>
            <div class="fld">
              <label>Update task status to</label>
              <select id="f-st">
                <option value="">No change</option>
                <option value="in_progress">In progress</option>
                <option value="blocked">Blocked</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>
          <button type="submit" class="btn btn-amber">Add to today's log</button>
        </form>
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px">
          Today's entries
          <span style="font-family:var(--mono);font-size:12px;font-weight:400;color:var(--ink-soft);margin-left:6px">${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}</span>
        </h2>
        ${logs.length
          ? logs.map(logRow).join('')
          : '<div class="empty">Nothing logged yet. Your manager\'s dashboard shows you as pending until you add an entry.</div>'}
      </div>
    </div>
    <div class="card">
      <h2 style="margin-bottom:10px">My pending tasks</h2>
      ${pending.length
        ? pending.map(t => {
          const isCollab = t.assignee_id !== G.me.id;
          return `
          <div class="task-mini" onclick="openTask(${t.id})">
            <div style="display:flex;gap:7px;align-items:center;margin-bottom:4px;flex-wrap:wrap">
              ${codeChip(t)} ${prPill(t)}
              ${isCollab ? '<span class="collab-badge">Collaborating</span>' : ''}
            </div>
            <div class="task-mini-title">${esc(t.title)}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:5px">
              ${duePill(t)}
              <div style="display:flex;align-items:center;gap:6px"><div class="progress" style="width:60px"><i style="width:${taskPct(t)}%"></i></div><span style="font-size:11px;font-weight:600;color:var(--ink)">${taskPct(t)}%</span></div>
            </div>
          </div>`;}).join('')
        : '<div class="empty">No pending tasks assigned to you</div>'}
    </div>
  </div>`;
}

function logRow(l) {
  return `<div class="logentry">
    <div class="top">
      ${l.task_code
        ? `<span class="code ${(l.task_company || '').toLowerCase()}">${esc(l.task_code)}</span>`
        : '<span class="code general">GENERAL</span>'}
      <span style="font-size:13px;font-weight:500">${esc(l.task_title || l.ad_hoc_title || 'Other work')}</span>
      ${l.task_status ? `<span class="pill s-${l.task_status}">${ST_LABEL[l.task_status] || l.task_status}</span>` : ''}
      ${l.hours ? `<span class="muted small">${l.hours}h</span>` : ''}
    </div>
    <div style="font-size:13.5px;margin-bottom:2px">${esc(l.description)}</div>
    <div class="t">${fmtTime(l.logged_at)}</div>
  </div>`;
}

function toggleAdhocTitle() {
  const taskSel = document.getElementById('f-task');
  const wrap    = document.getElementById('f-adhoc-wrap');
  if (!wrap) return;
  wrap.style.display = taskSel?.value ? 'none' : '';
}

async function submitLog(e) {
  e.preventDefault();
  const task_id      = document.getElementById('f-task').value || null;
  const description  = document.getElementById('f-txt').value.trim();
  const hours        = parseFloat(document.getElementById('f-hrs').value) || null;
  const status_after = document.getElementById('f-st').value || null;
  const ad_hoc_title = !task_id ? (document.getElementById('f-adhoc-title')?.value.trim() || null) : null;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', '/logs', { task_id: task_id ? +task_id : null, description, hours, status_after, ad_hoc_title });
    toast('Entry added ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── MY TASKS ──────────────────────────────────────────────────────────────────
async function renderMyTasks() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';
  G._myTasks = await api('GET', '/tasks') || [];
  drawMyPage();
}

function drawMyPage() {
  const main    = document.getElementById('main');
  if (!G._myTaskTab) G._myTaskTab = 'all';

  const myOwn      = G._myTasks.filter(t => t.assignee_id === G.me.id);
  const assignedBy = G._myTasks.filter(t => t.created_by === G.me.id && t.assignee_id !== G.me.id);
  const od         = myOwn.filter(isOverdue).length;
  const pending    = myOwn.filter(t => !['completed', 'cancelled'].includes(t.status)).length;

  const tab = (val, label, count) =>
    `<button class="comp-tab${G._myTaskTab === val ? ' active' : ''}"
      onclick="G._myTaskTab='${val}';drawMyPage()">${label}
      <span style="margin-left:5px;font-size:11px;opacity:0.7">(${count})</span>
    </button>`;

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>My tasks</h1>
    <div class="sub">${pending} pending · ${od} overdue</div></div>
  </div>
  <div class="comp-tabs" style="margin-bottom:12px">
    ${tab('all',        'All my tasks',    G._myTasks.length)}
    ${tab('assignedby', 'Assigned by me',  assignedBy.length)}
  </div>
  ${myFilterBarHtml()}
  <div id="my-table"></div>`;
  updateMyTable();
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
async function renderHistory() {
  const main = document.getElementById('main');

  // Default filter: this month
  if (!G._histPreset) G._histPreset = 'month';
  const today = TODAY();
  let from, to;
  if (G._histPreset === 'week') {
    const d = new Date(today);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    from = d.toISOString().slice(0, 10);
    to   = today;
  } else if (G._histPreset === 'month') {
    from = today.slice(0, 7) + '-01';
    to   = today;
  } else {
    from = G._histFrom || today.slice(0, 7) + '-01';
    to   = G._histTo   || today;
  }

  const qs   = `?from=${from}&to=${to}`;
  const logs = await api('GET', `/logs${qs}`) || [];

  const totalHours = logs.reduce((sum, l) => sum + (parseFloat(l.hours) || 0), 0);
  const totalDays  = new Set(logs.map(l => l.log_date.slice(0, 10))).size;

  const byDate = {};
  logs.forEach(l => {
    const d = l.log_date.slice(0, 10);
    (byDate[d] = byDate[d] || []).push(l);
  });
  const dates = Object.keys(byDate).sort().reverse();

  const presetBtn = (val, label) =>
    `<button class="btn btn-sm ${G._histPreset === val ? 'btn-amber' : 'btn-ghost'}"
      onclick="G._histPreset='${val}';renderView()">${label}</button>`;

  main.innerHTML = `
  <div class="pagehead"><div><h1>My history</h1><div class="sub">Past daily logs</div></div></div>

  <div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:${G._histPreset === 'custom' ? '12px' : '0'}">
      ${presetBtn('week', 'This week')}
      ${presetBtn('month', 'This month')}
      ${presetBtn('custom', 'Custom range')}
    </div>
    ${G._histPreset === 'custom' ? `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px">
        <span class="small">From</span>
        <input type="date" value="${from}" max="${today}"
          onchange="G._histFrom=this.value;renderView()"
          style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;background:var(--surface);color:var(--ink)">
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="small">To</span>
        <input type="date" value="${to}" max="${today}"
          onchange="G._histTo=this.value;renderView()"
          style="padding:6px 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;background:var(--surface);color:var(--ink)">
      </div>
    </div>` : ''}
  </div>

  <div class="kpis" style="margin-bottom:16px">
    <div class="kpi">
      <div class="n">${totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}</div>
      <div class="l">Hours logged</div>
    </div>
    <div class="kpi">
      <div class="n">${logs.length}</div>
      <div class="l">Log entries</div>
    </div>
    <div class="kpi">
      <div class="n">${totalDays}</div>
      <div class="l">Days worked</div>
    </div>
  </div>

  ${dates.map(d => `
    <div class="card" style="margin-bottom:14px">
      <h2 style="margin-bottom:10px">${fmtLong(d)}</h2>
      ${byDate[d].map(logRow).join('')}
    </div>`).join('') || '<div class="empty">No log entries found for this period.</div>'}`;
}

// ── DASHBOARD (admin) ─────────────────────────────────────────────────────────
async function renderDashboard() {
  const main = document.getElementById('main');
  const cf   = G.compFilter;
  const qs   = cf !== 'ALL' ? `?company=${cf}` : '';

  const [stats, summary, tasks] = await Promise.all([
    api('GET', `/dashboard/stats${qs}`),
    api('GET', `/logs/today-summary${qs}`),
    api('GET', `/tasks${qs}`),
  ]);

  const ts  = stats?.tasks     || {};
  const es  = stats?.employees || {};
  const ppl = summary || [];
  const notLogged  = ppl.filter(u => !u.has_logged);
  const overdueT   = (tasks || []).filter(isOverdue);
  const blockedT   = (tasks || []).filter(t => t.status === 'blocked');

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Dashboard</h1>
    <div class="sub">${new Date().toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })} · Live view across teams</div></div>
    <div class="comp-tabs">
      ${['ALL', 'VTX', 'VSN'].map(c =>
        `<button class="${cf === c ? 'active' : ''}" onclick="G.compFilter='${c}';renderView()">
          ${c === 'ALL' ? 'Both companies' : c === 'VTX' ? 'Vertex' : 'Vision'}
        </button>`).join('')}
    </div>
  </div>

  <div class="kpis">
    <div class="kpi ok clickable" onclick="go('dailylogs')" title="View daily logs">
      <div class="n">${es.logged_today || 0}/${es.total_employees || 0}</div>
      <div class="l">Logged work today</div>
    </div>
    <div class="kpi ${+ts.overdue > 0 ? 'warn' : ''} clickable" onclick="dashFilter('overdue')" title="View overdue tasks">
      <div class="n">${ts.overdue || 0}</div>
      <div class="l">Overdue tasks</div>
    </div>
    <div class="kpi ${+ts.blocked > 0 ? 'warn' : ''} clickable" onclick="dashFilter('blocked')" title="View blocked tasks">
      <div class="n">${ts.blocked || 0}</div>
      <div class="l">Blocked</div>
    </div>
    <div class="kpi clickable" onclick="dashFilter('thisweek')" title="View tasks due this week">
      <div class="n">${ts.due_this_week || 0}</div>
      <div class="l">Due this week</div>
    </div>
  </div>

  <div class="grid2" style="grid-template-columns:270px 1fr">
    <div>
      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:10px;cursor:pointer" onclick="go('dailylogs')" title="View daily logs">Not yet logged today →</h2>
        ${notLogged.map(u => `
          <div class="name-dot" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span class="dot" style="background:var(--red)"></span>
            <div>
              <div style="font-size:13.5px;font-weight:500">${esc(u.name)}</div>
              <div class="small muted">${esc(u.department || '')} · ${u.company === 'VTX' ? 'Vertex' : u.company === 'VSN' ? 'Vision' : 'Both'}</div>
            </div>
          </div>`).join('') || '<div class="empty">Everyone has logged ✓</div>'}
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px;cursor:pointer" onclick="go('dailylogs')" title="View daily logs">Who logged today →</h2>
        ${ppl.filter(u => u.has_logged).map(u => `
          <div class="name-dot" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span class="dot" style="background:var(--green)"></span>
            <div>
              <div style="font-size:13.5px;font-weight:500">${esc(u.name)}</div>
              <div class="small muted">${u.total_hours || 0}h logged · ${esc(u.department || '')}</div>
            </div>
          </div>`).join('') || '<div class="empty">No entries yet</div>'}
      </div>
    </div>
    <div>
      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:10px;cursor:pointer" onclick="dashFilter('overdue')" title="View all overdue tasks">⚠ Overdue tasks →</h2>
        ${overdueT.length ? dashTaskList(overdueT) : '<div class="empty">No overdue tasks</div>'}
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px;cursor:pointer" onclick="dashFilter('blocked')" title="View all blocked tasks">Blocked tasks →</h2>
        ${blockedT.length ? dashTaskList(blockedT) : '<div class="empty">Nothing blocked</div>'}
      </div>
    </div>
  </div>`;
}

// ── TEAM TASKS (admin) ────────────────────────────────────────────────────────
async function renderTeam() {
  const main = document.getElementById('main');
  const cf   = G.compFilter;
  G._selectedIds.clear();
  G.tf = G._dashFilter || { search: '', status: '', priority: '', assignee: '', overdue: false, thisweek: false };
  G._dashFilter = null;
  main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';
  G._teamTasks = await api('GET', `/tasks${cf !== 'ALL' ? `?company=${cf}` : ''}`) || [];
  drawTeamPage();
}

function drawTeamPage() {
  const main   = document.getElementById('main');
  const cf     = G.compFilter;
  const active = G._teamTasks.filter(t => !['completed', 'cancelled'].includes(t.status)).length;
  const assignees = [...new Map(G._teamTasks.map(t => [t.assignee_id, { id: t.assignee_id, name: t.assignee_name }])).values()]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Team tasks</h1>
    <div class="sub">${G._teamTasks.length} total · ${active} active</div></div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div class="comp-tabs">
        ${['ALL', 'VTX', 'VSN'].map(c =>
          `<button class="${cf === c ? 'active' : ''}" onclick="G.compFilter='${c}';renderView()">
            ${c === 'ALL' ? 'Both' : c === 'VTX' ? 'Vertex' : 'Vision'}
          </button>`).join('')}
      </div>
      <button class="btn btn-amber btn-sm" onclick="go('assign')">+ Assign task</button>
    </div>
  </div>
  ${teamFilterBarHtml(assignees)}
  <div id="team-table"></div>`;
  updateTeamTable();
}

// ── ASSIGN TASK (admin) ───────────────────────────────────────────────────────
async function renderAssign() {
  const main  = document.getElementById('main');
  const users = await api('GET', '/users') || [];
  const emps  = users.filter(u => u.active);

  window._assignEmps = { VTX: emps.filter(u => u.company === 'VTX' || u.company === 'ALL'), VSN: emps.filter(u => u.company === 'VSN' || u.company === 'ALL') };
  const empOpts = (list) => list.map(u =>
    `<option value="${u.id}">${esc(u.name)} — ${esc(u.department || '')}</option>`).join('');

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Assign task</h1><div class="sub">Create and assign a task to any employee or admin</div></div>
  </div>
  <div class="card" style="max-width:660px">
    <form id="assign-form" onsubmit="submitAssign(event)">
      <div class="fld">
        <label>Task title</label>
        <input id="a-title" placeholder="e.g. Dispatch 500 meters to LESCO Warehouse" required>
      </div>
      <div class="fld">
        <label>Description</label>
        <textarea id="a-desc" rows="3" placeholder="What exactly needs to be done — PO numbers, references…"></textarea>
      </div>
      <div class="row">
        <div class="fld">
          <label>Company</label>
          <select id="a-comp" onchange="refreshAssigneeList(this.value)">
            <option value="VTX">Vertex Electronics</option>
            <option value="VSN">Vision Engineering</option>
          </select>
        </div>
        <div class="fld">
          <label>Assign to</label>
          <select id="a-emp">${empOpts(window._assignEmps.VTX)}</select>
        </div>
      </div>
      <div class="row">
        <div class="fld">
          <label>Priority</label>
          <select id="a-pr">
            <option value="high">High</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="fld">
          <label>Deadline</label>
          <input id="a-due" type="date" value="${tomorrow}" required>
        </div>
      </div>
      <div class="fld">
        <label>Objectives — one per line (optional)</label>
        <textarea id="a-objs" rows="4" placeholder="e.g.&#10;QC sign-off on batch&#10;Gate pass issued&#10;Transport booked&#10;Delivery confirmed"></textarea>
      </div>
      <div class="fld">
        <label>Attach file (optional)</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span id="assign-file-name">Choose file</span>
            <input type="file" id="assign-file" style="display:none" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp" onchange="updateFileLabel('assign-file','assign-file-name')">
          </label>
          <span class="muted small">PDF, Word, Excel, images · max 20 MB</span>
        </div>
      </div>
      <button type="submit" class="btn btn-amber">Assign task</button>
      <button type="button" class="btn btn-ghost" style="margin-left:8px" onclick="go('team')">Cancel</button>
    </form>
  </div>`;
}

function refreshAssigneeList(comp) {
  const list = (window._assignEmps || {})[comp] || [];
  document.getElementById('a-emp').innerHTML = list.map(u =>
    `<option value="${u.id}">${esc(u.name)} — ${esc(u.department || '')}</option>`).join('');
}

async function submitAssign(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const objsRaw = document.getElementById('a-objs').value.trim();
  const objectives = objsRaw ? objsRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
  try {
    const task = await api('POST', '/tasks', {
      title:       document.getElementById('a-title').value.trim(),
      description: document.getElementById('a-desc').value.trim() || null,
      company:     document.getElementById('a-comp').value,
      assignee_id: +document.getElementById('a-emp').value,
      priority:    document.getElementById('a-pr').value,
      due_date:    document.getElementById('a-due').value,
      objectives,
    });
    const fileInput = document.getElementById('assign-file');
    if (fileInput?.files[0] && task?.id) {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        await fetch(`/api/attachments/task/${task.id}`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${G.token}` }, body: fd,
        });
      } catch (_) {}
    }
    toast(`${task.code} assigned to ${task.assignee_name}`, 'success');
    go('team');
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── ASSIGN TASK (employee) ────────────────────────────────────────────────────
async function renderEmpAssign() {
  const main  = document.getElementById('main');
  const users = await api('GET', '/users/active') || [];
  const emps  = users.filter(u => u.role !== 'admin');

  // Group by company; put "Myself" first in the matching company group
  window._empAssignUsers = {
    VTX: emps.filter(u => u.company === 'VTX' || u.company === 'ALL'),
    VSN: emps.filter(u => u.company === 'VSN' || u.company === 'ALL'),
  };

  const myCompany = G.me.company || 'VTX';

  const empOpts = (list) => {
    const me = list.find(u => u.id === G.me.id);
    const others = list.filter(u => u.id !== G.me.id);
    return (me ? `<option value="${me.id}">Myself (${esc(me.name)})</option>` : '') +
      others.map(u => `<option value="${u.id}">${esc(u.name)}${u.department ? ' — ' + esc(u.department) : ''}</option>`).join('');
  };

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Assign task</h1><div class="sub">Create and assign a task to any employee</div></div>
  </div>
  <div class="card" style="max-width:660px">
    <form id="emp-assign-form" onsubmit="submitEmpAssign(event)">
      <div class="fld">
        <label>Task title</label>
        <input id="ea-title" placeholder="e.g. Dispatch 500 meters to LESCO Warehouse" required>
      </div>
      <div class="fld">
        <label>Description</label>
        <textarea id="ea-desc" rows="3" placeholder="What exactly needs to be done — PO numbers, references…"></textarea>
      </div>
      <div class="row">
        <div class="fld">
          <label>Company</label>
          <select id="ea-comp" onchange="refreshEmpAssigneeList(this.value)">
            <option value="VTX"${myCompany === 'VTX' ? ' selected' : ''}>Vertex Electronics</option>
            <option value="VSN"${myCompany === 'VSN' ? ' selected' : ''}>Vision Engineering</option>
          </select>
        </div>
        <div class="fld">
          <label>Assign to</label>
          <select id="ea-emp">${empOpts(window._empAssignUsers[myCompany] || window._empAssignUsers.VTX)}</select>
        </div>
      </div>
      <div class="row">
        <div class="fld">
          <label>Priority</label>
          <select id="ea-pr">
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div class="fld">
          <label>Deadline</label>
          <input id="ea-due" type="date" value="${tomorrow}" required>
        </div>
      </div>
      <div class="fld">
        <label>Objectives — one per line (optional)</label>
        <textarea id="ea-objs" rows="4" placeholder="e.g.&#10;QC sign-off on batch&#10;Gate pass issued&#10;Transport booked&#10;Delivery confirmed"></textarea>
      </div>
      <div class="fld">
        <label>Attach file (optional)</label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span id="ea-file-name">Choose file</span>
            <input type="file" id="ea-file" style="display:none" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp" onchange="updateFileLabel('ea-file','ea-file-name')">
          </label>
          <span class="muted small">PDF, Word, Excel, images · max 20 MB</span>
        </div>
      </div>
      <button type="submit" class="btn btn-amber">Assign task</button>
      <button type="button" class="btn btn-ghost" style="margin-left:8px" onclick="go('mytasks')">Cancel</button>
    </form>
  </div>`;
}

function refreshEmpAssigneeList(comp) {
  const list = (window._empAssignUsers || {})[comp] || [];
  const me = list.find(u => u.id === G.me.id);
  const others = list.filter(u => u.id !== G.me.id);
  document.getElementById('ea-emp').innerHTML =
    (me ? `<option value="${me.id}">Myself (${esc(me.name)})</option>` : '') +
    others.map(u => `<option value="${u.id}">${esc(u.name)}${u.department ? ' — ' + esc(u.department) : ''}</option>`).join('');
}

async function submitEmpAssign(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const objsRaw = document.getElementById('ea-objs').value.trim();
  const objectives = objsRaw ? objsRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
  try {
    const task = await api('POST', '/tasks', {
      title:       document.getElementById('ea-title').value.trim(),
      description: document.getElementById('ea-desc').value.trim() || null,
      company:     document.getElementById('ea-comp').value,
      assignee_id: +document.getElementById('ea-emp').value,
      priority:    document.getElementById('ea-pr').value,
      due_date:    document.getElementById('ea-due').value,
      objectives,
    });
    const fileInput = document.getElementById('ea-file');
    if (fileInput?.files[0] && task?.id) {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        await fetch(`/api/attachments/task/${task.id}`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${G.token}` }, body: fd,
        });
      } catch (_) {}
    }
    toast(`${task.code} created successfully`, 'success');
    go('mytasks');
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── MANAGE USERS (admin) ──────────────────────────────────────────────────────
async function renderUsers() {
  const main  = document.getElementById('main');
  const users = await api('GET', '/users') || [];
  window._usersData = users;

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Manage users</h1>
    <div class="sub">${users.filter(u => u.active).length} active · ${users.filter(u => !u.active).length} inactive</div></div>
    <div style="display:flex;gap:8px;align-items:center">
      <div id="user-bulk-bar" style="display:none;align-items:center;gap:8px">
        <span id="user-sel-count" class="small muted"></span>
        <button class="btn btn-danger btn-sm" onclick="deleteSelectedUsers()">Delete selected</button>
      </div>
      <button class="btn btn-amber" onclick="showUserForm()">+ Add user</button>
    </div>
  </div>
  <div id="user-form-panel"></div>
  <div class="table-wrap"><table id="users-table">
    <thead><tr>
      <th style="width:36px"><input type="checkbox" id="user-sel-all" onclick="usersToggleAll(this)" title="Select all"></th>
      <th>Name</th><th>Email</th><th>Company</th><th>Department</th><th>Role</th><th>Status</th>
      <th title="Enable / disable attendance marking for this employee">Attendance</th><th></th>
    </tr></thead>
    <tbody>
    ${users.map(u => `<tr data-uid="${u.id}">
      <td><input type="checkbox" class="user-sel-cb" value="${u.id}" onchange="usersOnCheck()"></td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="avatar-sm">${initials(u.name)}</div>
          <span style="font-weight:500">${esc(u.name)}</span>
        </div>
      </td>
      <td class="small muted">${esc(u.email)}</td>
      <td><span class="code ${u.company.toLowerCase()}">${u.company}</span></td>
      <td class="small">${esc(u.department || '—')}</td>
      <td><span class="pill ${u.role === 'admin' ? 'p-high' : 's-in_progress'}">${u.role}</span></td>
      <td><span class="pill ${u.active ? 's-completed' : 's-not_started'}">${u.active ? 'Active' : 'Inactive'}</span></td>
      <td style="text-align:center">
        ${u.role === 'employee'
          ? `<label class="att-toggle" title="${u.attendance_enabled ? 'Click to disable attendance' : 'Click to enable attendance'}">
               <input type="checkbox" ${u.attendance_enabled ? 'checked' : ''} onchange="attToggleUser(${u.id},${u.attendance_enabled})">
               <span class="att-toggle-slider"></span>
             </label>`
          : '<span class="muted small">—</span>'}
      </td>
      <td><button class="btn btn-ghost btn-sm" onclick="showUserForm(${u.id})">Edit</button></td>
    </tr>`).join('')}
    </tbody></table></div>`;
}

function usersOnCheck() {
  const cbs   = [...document.querySelectorAll('.user-sel-cb')];
  const sel   = cbs.filter(c => c.checked);
  const bar   = document.getElementById('user-bulk-bar');
  const count = document.getElementById('user-sel-count');
  const all   = document.getElementById('user-sel-all');
  bar.style.display   = sel.length ? 'flex' : 'none';
  count.textContent   = `${sel.length} selected`;
  all.indeterminate   = sel.length > 0 && sel.length < cbs.length;
  all.checked         = sel.length === cbs.length;
}

function usersToggleAll(masterCb) {
  document.querySelectorAll('.user-sel-cb').forEach(c => { c.checked = masterCb.checked; });
  usersOnCheck();
}

async function deleteSelectedUsers() {
  const ids = [...document.querySelectorAll('.user-sel-cb:checked')].map(c => +c.value);
  if (!ids.length) return;
  const names = ids.map(id => (window._usersData || []).find(u => u.id === id)?.name || id).join(', ');
  if (!confirm(`Permanently delete ${ids.length} user(s)?\n\n${names}\n\nThis cannot be undone. Users with tasks or logs cannot be deleted (you will be told to deactivate them instead).`)) return;

  const errors = [];
  for (const id of ids) {
    try {
      await api('DELETE', `/users/${id}`);
    } catch (e) {
      const u = (window._usersData || []).find(x => x.id === id);
      errors.push(`${u?.name || id}: ${e.message}`);
    }
  }
  await renderUsers();
  if (errors.length) alert('Some users could not be deleted:\n\n' + errors.join('\n'));
}

function showUserForm(userId) {
  const user = userId ? (window._usersData || []).find(u => u.id === userId) : null;
  const isNew = !user;
  const panel = document.getElementById('user-form-panel');

  panel.innerHTML = `
  <div class="card" style="margin-bottom:20px;max-width:660px">
    <h2 style="margin-bottom:14px">${isNew ? 'Add new user' : `Edit: ${esc(user.name)}`}</h2>
    <form onsubmit="${isNew ? 'submitAddUser' : `submitEditUser`}(event${isNew ? '' : `, ${userId}`})">
      <div class="row">
        <div class="fld">
          <label>Full name</label>
          <input id="uf-name" value="${isNew ? '' : esc(user.name)}" required>
        </div>
        <div class="fld">
          <label>Email address</label>
          <input id="uf-email" type="email" value="${isNew ? '' : esc(user.email)}" required>
        </div>
      </div>
      <div class="row">
        <div class="fld">
          <label>${isNew ? 'Password' : 'New password (blank = no change)'}</label>
          <input id="uf-pass" type="password" ${isNew ? 'required minlength="6"' : 'minlength="6"'} placeholder="Min 6 characters">
        </div>
        <div class="fld">
          <label>Role</label>
          <select id="uf-role">
            <option value="employee" ${!user || user.role === 'employee' ? 'selected' : ''}>Employee</option>
            <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="fld">
          <label>Company</label>
          <select id="uf-comp">
            <option value="VTX" ${(!user || user.company === 'VTX') ? 'selected' : ''}>Vertex Electronics</option>
            <option value="VSN" ${user?.company === 'VSN' ? 'selected' : ''}>Vision Engineering</option>
            <option value="ALL" ${user?.company === 'ALL' ? 'selected' : ''}>Both companies</option>
          </select>
        </div>
        <div class="fld">
          <label>Department</label>
          <input id="uf-dept" placeholder="e.g. Production, QA, Accounts" value="${isNew ? '' : esc(user.department || '')}">
        </div>
      </div>
      ${!isNew ? `<div class="fld">
        <label>Status</label>
        <select id="uf-active">
          <option value="true"  ${user.active ? 'selected' : ''}>Active</option>
          <option value="false" ${!user.active ? 'selected' : ''}>Inactive</option>
        </select>
      </div>` : ''}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="submit" class="btn btn-amber">${isNew ? 'Create user' : 'Save changes'}</button>
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('user-form-panel').innerHTML=''">Cancel</button>
      </div>
    </form>
  </div>`;
}

async function submitAddUser(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', '/users', {
      name:       document.getElementById('uf-name').value.trim(),
      email:      document.getElementById('uf-email').value.trim(),
      password:   document.getElementById('uf-pass').value,
      role:       document.getElementById('uf-role').value,
      company:    document.getElementById('uf-comp').value,
      department: document.getElementById('uf-dept').value.trim() || null,
    });
    toast('User created ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

async function submitEditUser(e, userId) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const body = {
    name:       document.getElementById('uf-name').value.trim(),
    email:      document.getElementById('uf-email').value.trim(),
    role:       document.getElementById('uf-role').value,
    company:    document.getElementById('uf-comp').value,
    department: document.getElementById('uf-dept').value.trim() || null,
    active:     document.getElementById('uf-active').value === 'true',
  };
  const pass = document.getElementById('uf-pass').value;
  if (pass) body.password = pass;
  try {
    await api('PUT', `/users/${userId}`, body);
    toast('User updated ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── TASK DETAIL ───────────────────────────────────────────────────────────────
async function renderDetail(id) {
  const main    = document.getElementById('main');
  const isAdmin = G.me.role === 'admin';
  const [task, logs, comments, taskFiles, allUsers] = await Promise.all([
    api('GET', `/tasks/${id}`),
    api('GET', `/logs?task_id=${id}`),
    api('GET', `/comments?task_id=${id}`),
    api('GET', `/attachments/task/${id}`),
    isAdmin ? api('GET', '/users') : api('GET', '/users/active'),
  ]);

  if (!task) { main.innerHTML = '<div class="error-msg">Task not found</div>'; return; }

  const pct            = taskPct(task);
  const backView       = isAdmin ? 'team' : 'mytasks';
  const isCollaborator = (task.collaborators || []).some(c => c.id === G.me.id);
  const canAct         = isAdmin || task.assignee_id === G.me.id || isCollaborator;
  const canManageCollabs = isAdmin || task.assignee_id === G.me.id;
  const companyUsers   = (allUsers || []).filter(u => u.active !== false);
  G._detailUsers       = companyUsers;

  main.innerHTML = `
  <button class="backlink" onclick="go('${backView}')">← Back to tasks</button>
  <div class="pagehead" style="margin-top:10px">
    <div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        ${codeChip(task)} ${prPill(task)} ${stPill(task)} ${duePill(task)}
      </div>
      <h1>${esc(task.title)}</h1>
      <div class="sub">
        Assigned to <b>${esc(task.assignee_name || '—')}</b>
        ${task.assignee_dept ? ` (${esc(task.assignee_dept)})` : ''}
        · by ${esc(task.created_by_name || '—')}
        · created ${fmt(task.created_at)}
        ${isCollaborator ? ' · <span class="collab-badge">You are collaborating</span>' : ''}
      </div>
    </div>
    ${canAct ? `<div style="display:flex;gap:8px;flex-wrap:wrap">
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="openEditTask(${task.id})">Edit task</button>` : ''}
      ${task.status !== 'completed'
        ? `<button class="btn btn-amber btn-sm" onclick="setStatus(${task.id},'completed')">Mark completed</button>` : ''}
      ${task.status !== 'blocked' && task.status !== 'completed'
        ? `<button class="btn btn-ghost btn-sm" onclick="setStatus(${task.id},'blocked')">Mark blocked</button>` : ''}
      ${task.status === 'blocked'
        ? `<button class="btn btn-ghost btn-sm" onclick="setStatus(${task.id},'in_progress')">Unblock</button>` : ''}
      ${isAdmin ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="archiveTask(${task.id})">Archive</button>` : ''}
    </div>` : ''}
  </div>

  <div class="grid2">
    <div>
      ${task.description ? `<div class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:8px">Description</h2>
        <div style="font-size:13.5px;white-space:pre-wrap;line-height:1.6">${esc(task.description)}</div>
      </div>` : ''}

      <div class="card">
        <h2 style="margin-bottom:14px">Comments & Updates</h2>
        ${(taskFiles||[]).length ? `
          <div style="padding:8px 10px;background:var(--grey-s);border-radius:6px;margin-bottom:14px">
            <div class="small muted" style="margin-bottom:6px;font-weight:600">Task files</div>
            <div style="display:flex;flex-wrap:wrap;gap:5px">
              ${(taskFiles||[]).map(a => `
                <button onclick="downloadAttachment(${a.id})" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--line);border-radius:4px;background:#fff;font-size:12px;cursor:pointer;color:var(--ink)">
                  <span style="font-size:10px;font-weight:700;color:var(--accent)">${fileTypeLabel(a.mime_type)}</span>
                  ${esc(a.original_name)}
                  <span class="muted" style="font-size:11px">${fmtSize(a.file_size)}</span>
                </button>`).join('')}
            </div>
          </div>` : ''}
        <div id="comments-list">
          ${(() => {
            const topComments = (comments || []).filter(c => !c.parent_id);
            const replyMap = {};
            (comments || []).filter(c => c.parent_id).forEach(c => {
              (replyMap[c.parent_id] = replyMap[c.parent_id] || []).push(c);
            });

            const timeline = [
              ...(logs || []).map(l => ({ ...l, _type: 'log', _ts: new Date(l.logged_at) })),
              ...topComments.map(c => ({ ...c, _type: 'comment', _ts: new Date(c.created_at) }))
            ].sort((a, b) => a._ts - b._ts);

            if (!timeline.length) return '<div class="muted small" style="padding:8px 0">No activity yet</div>';

            return timeline.map(item => {
              if (item._type === 'log') {
                return `<div class="comment" style="border-left:3px solid var(--green);padding-left:10px">
                  <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                    <span style="font-size:11px;font-weight:600;color:#fff;background:var(--green);padding:2px 7px;border-radius:4px">Work update</span>
                    <b style="font-size:13px;color:${userColor(item.user_id)}">${esc(item.user_name || '')}</b>
                    <span class="t">${fmt(item.log_date)} ${fmtTime(item.logged_at)}</span>
                    ${item.status_after ? `<span class="pill s-${item.status_after}">→ ${ST_LABEL[item.status_after] || item.status_after}</span>` : ''}
                    ${item.hours ? `<span class="muted small">${item.hours}h</span>` : ''}
                  </div>
                  <div style="margin-top:5px;font-size:13.5px">${esc(item.description)}</div>
                </div>`;
              } else {
                return commentHtml(item, replyMap, task.id);
              }
            }).join('');
          })()}
        </div>
        <div id="comment-form-wrap" style="margin-top:12px">
          <input id="c-txt" placeholder="Write a comment…" style="width:100%;margin-bottom:7px">
          <div style="display:flex;align-items:center;gap:8px">
            <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span id="c-file-name">Attach file</span>
              <input type="file" id="c-file" style="display:none" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp" onchange="updateFileLabel('c-file','c-file-name')">
            </label>
            <button class="btn btn-sm" style="margin-left:auto" onclick="submitComment(${task.id})">Post</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2>Objectives</h2>
        <span style="font-family:var(--mono);font-size:14px;font-weight:600;color:${pct === 100 ? 'var(--green)' : 'var(--ink)'}">${pct}%</span>
      </div>
      <div class="progress" style="margin-bottom:14px">
        <i style="width:${pct}%;background:${pct === 100 ? 'var(--green)' : 'var(--accent)'}"></i>
      </div>
      ${(task.objectives || []).length
        ? task.objectives.map(o => `
          <label class="obj${o.done ? ' done' : ''}">
            <input type="checkbox" ${o.done ? 'checked' : ''} ${canAct ? '' : 'disabled'}
              onchange="toggleObj(${task.id}, ${o.id}, this.checked)">
            <span>${esc(o.text)}</span>
          </label>`).join('')
        : '<div class="empty">No objectives defined</div>'}

      ${isAdmin && companyUsers.length > 0 ? `
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        <div class="small" style="margin-bottom:8px;font-weight:600">Reassign task</div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="reassign-sel" style="flex:1;margin:0">
            ${companyUsers.map(u => `<option value="${u.id}"${u.id === task.assignee_id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>
          <button class="btn btn-sm" onclick="reassignTask(${task.id})">Reassign</button>
        </div>
      </div>` : ''}

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        <div class="small" style="margin-bottom:10px;font-weight:600">Task Team</div>
        <div id="task-team-panel">${buildTeamPanel(task, G.me)}</div>
      </div>

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        <div class="small muted" style="margin-bottom:6px">
          Created ${fmt(task.created_at)} · Updated ${fmt(task.updated_at)}
        </div>
      </div>
    </div>
  </div>`;

  startCommentPolling(id);
}

async function toggleObj(taskId, objId, done) {
  try {
    await api('PUT', `/tasks/${taskId}/objectives/${objId}`, { done });
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function setStatus(taskId, status) {
  try {
    await api('PUT', `/tasks/${taskId}`, { status });
    toast('Status updated', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function archiveTask(taskId) {
  if (!confirm('Archive this task? It will be hidden from all views but can be restored later.')) return;
  try {
    await api('PATCH', `/tasks/${taskId}/archive`);
    toast('Task archived', 'success');
    go('team');
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

function toggleTaskCheck(id, checked) {
  if (checked) G._selectedIds.add(id);
  else G._selectedIds.delete(id);
  updateTeamTable();
}

function toggleAllCheck(checked) {
  const filtered = applyTaskFilters(G._teamTasks, G.tf);
  filtered.forEach(t => checked ? G._selectedIds.add(t.id) : G._selectedIds.delete(t.id));
  updateTeamTable();
}

function clearSelection() {
  G._selectedIds.clear();
  updateTeamTable();
}

async function archiveSelected() {
  const ids = [...G._selectedIds];
  if (!ids.length) return;
  if (!confirm(`Archive ${ids.length} task${ids.length > 1 ? 's' : ''}? They can be restored from Archived tasks.`)) return;
  try {
    await Promise.all(ids.map(id => api('PATCH', `/tasks/${id}/archive`)));
    G._selectedIds.clear();
    G._teamTasks = G._teamTasks.filter(t => !ids.includes(t.id));
    toast(`${ids.length} task${ids.length > 1 ? 's' : ''} archived`, 'success');
    updateTeamTable();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function restoreTask(taskId) {
  try {
    await api('PATCH', `/tasks/${taskId}/archive`);
    G._archivedTasks = G._archivedTasks.filter(t => t.id !== taskId);
    G._archivedIds.delete(taskId);
    toast('Task restored', 'success');
    drawArchivedPage();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function reassignTask(taskId) {
  const sel = document.getElementById('reassign-sel');
  if (!sel) return;
  const assignee_id = parseInt(sel.value, 10);
  try {
    await api('PUT', `/tasks/${taskId}`, { assignee_id });
    toast('Task reassigned', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function addCollaborator(taskId) {
  const sel = document.getElementById('collab-sel');
  if (!sel || !sel.value) return;
  const user_id = parseInt(sel.value, 10);
  try {
    await api('POST', `/tasks/${taskId}/collaborators`, { user_id });
    toast('Collaborator added', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function removeCollaborator(taskId, userId) {
  try {
    await api('DELETE', `/tasks/${taskId}/collaborators/${userId}`);
    toast('Collaborator removed', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function renderArchived() {
  const main = document.getElementById('main');
  G._archivedIds.clear();
  main.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';
  G._archivedTasks = await api('GET', '/tasks?archived=true') || [];
  drawArchivedPage();
}

function drawArchivedPage() {
  const main  = document.getElementById('main');
  const tasks = G._archivedTasks;

  if (!tasks.length) {
    main.innerHTML = `
      <div class="pagehead"><h1>Archived Tasks</h1></div>
      <div class="empty">No archived tasks</div>`;
    return;
  }

  const allChecked = tasks.length > 0 && tasks.every(t => G._archivedIds.has(t.id));
  const bulkBar = G._archivedIds.size > 0 ? `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--accent-s);border-radius:8px;margin-bottom:12px;border:1px solid #b8daf2;flex-wrap:wrap">
      <span style="font-size:13.5px;font-weight:600">${G._archivedIds.size} task${G._archivedIds.size > 1 ? 's' : ''} selected</span>
      <button class="btn btn-sm" style="color:var(--green);border-color:var(--green)" onclick="restoreSelected()">Restore selected</button>
      <button class="btn btn-ghost btn-sm" onclick="clearArchivedSelection()">Clear selection</button>
    </div>` : '';

  main.innerHTML = `
    <div class="pagehead"><h1>Archived Tasks</h1></div>
    ${bulkBar}
    <div class="card" style="overflow-x:auto">
      <table class="tbl">
        <thead><tr>
          <th style="width:36px"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="toggleAllArchivedCheck(this.checked)" title="Select all"></th>
          <th>Code</th><th>Title</th><th>Assigned to</th><th>Status</th><th>Archived on</th><th></th>
        </tr></thead>
        <tbody>
          ${tasks.map(t => `<tr>
            <td><input type="checkbox" ${G._archivedIds.has(t.id) ? 'checked' : ''} onchange="toggleArchivedCheck(${t.id}, this.checked)"></td>
            <td><code>${esc(t.code)}</code></td>
            <td>${esc(t.title)}</td>
            <td>${esc(t.assignee_name || '—')}</td>
            <td>${stPill(t)}</td>
            <td>${fmt(t.updated_at)}</td>
            <td><button class="btn btn-ghost btn-sm" onclick="restoreTask(${t.id})">Restore</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function toggleArchivedCheck(id, checked) {
  if (checked) G._archivedIds.add(id);
  else G._archivedIds.delete(id);
  drawArchivedPage();
}

function toggleAllArchivedCheck(checked) {
  G._archivedTasks.forEach(t => checked ? G._archivedIds.add(t.id) : G._archivedIds.delete(t.id));
  drawArchivedPage();
}

function clearArchivedSelection() {
  G._archivedIds.clear();
  drawArchivedPage();
}

async function restoreSelected() {
  const ids = [...G._archivedIds];
  if (!ids.length) return;
  if (!confirm(`Restore ${ids.length} task${ids.length > 1 ? 's' : ''}?`)) return;
  try {
    await Promise.all(ids.map(id => api('PATCH', `/tasks/${id}/archive`)));
    G._archivedIds.clear();
    G._archivedTasks = G._archivedTasks.filter(t => !ids.includes(t.id));
    toast(`${ids.length} task${ids.length > 1 ? 's' : ''} restored`, 'success');
    drawArchivedPage();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function submitComment(taskId) {
  const el        = document.getElementById('c-txt');
  const fileInput = document.getElementById('c-file');
  const btn       = document.querySelector('#comment-form-wrap .btn:not(.btn-ghost)');
  if (!el?.value.trim()) return;
  btn.disabled = true;
  try {
    const c = await api('POST', '/comments', { task_id: taskId, text: el.value.trim() });
    if (!c) return;
    if (fileInput?.files[0]) {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        const r = await fetch(`/api/attachments/comment/${c.id}`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${G.token}` }, body: fd,
        });
        if (r.ok) c.attachments = [await r.json()];
      } catch (_) {}
      fileInput.value = '';
      const lbl = document.getElementById('c-file-name');
      if (lbl) lbl.textContent = 'Attach file';
    }
    el.value = '';
    const list = document.getElementById('comments-list');
    const empty = list.querySelector('.muted.small');
    if (empty) empty.remove();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = commentHtml(c, {}, taskId);
    list.appendChild(wrapper.firstElementChild);
  } catch (ex) {
    toast(ex.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── DAILY LOGS (admin) ────────────────────────────────────────────────────────
async function renderDailyLogs() {
  const main = document.getElementById('main');
  const date = G.logsDate || TODAY();
  G.logsDate = date;

  const [logs, users] = await Promise.all([
    api('GET', `/logs?date=${date}`),
    api('GET', '/users'),
  ]);

  const allEmps = (users || []).filter(u => u.role === 'employee' && u.active);
  const loggedIds = new Set((logs || []).map(l => l.user_id));
  const notLogged = allEmps.filter(u => !loggedIds.has(u.id));

  const byUser = {};
  (logs || []).forEach(l => {
    if (!byUser[l.user_id]) byUser[l.user_id] = { name: l.user_name, entries: [] };
    byUser[l.user_id].entries.push(l);
  });

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Daily logs</h1><div class="sub">View all employee log entries for any date</div></div>
    <div style="display:flex;align-items:center;gap:10px">
      <input type="date" value="${date}" max="${TODAY()}"
        onchange="G.logsDate=this.value;renderView()"
        style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px;background:var(--surface);color:var(--ink)">
    </div>
  </div>

  ${Object.keys(byUser).length === 0 && notLogged.length === 0
    ? '<div class="card"><div class="empty">No employees found</div></div>'
    : ''}

  ${Object.values(byUser).map(u => `
    <div class="card" style="margin-bottom:14px">
      <h2 style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
        <div class="avatar-sm">${initials(u.name)}</div>
        ${esc(u.name)}
        <span class="pill s-completed" style="font-size:11px">${u.entries.length} entr${u.entries.length === 1 ? 'y' : 'ies'}</span>
        <span class="muted small" style="font-weight:400">${u.entries.reduce((s, e) => s + (e.hours || 0), 0)}h total</span>
      </h2>
      ${u.entries.map(l => `
        <div class="logentry">
          <div class="top">
            ${l.task_code
              ? `<span class="code ${(l.task_company || '').toLowerCase()}">${esc(l.task_code)}</span>
                 <span style="font-size:13px;font-weight:500">${esc(l.task_title || '')}</span>`
              : `<span class="code general">GENERAL</span><span style="font-size:13px;font-weight:500">${esc(l.ad_hoc_title || 'Other work')}</span>`}
            ${l.task_status ? `<span class="pill s-${l.task_status}">${ST_LABEL[l.task_status] || l.task_status}</span>` : ''}
            ${l.hours ? `<span class="muted small">${l.hours}h</span>` : ''}
          </div>
          <div style="font-size:13.5px;margin-top:4px">${esc(l.description)}</div>
          <div class="t">${fmtTime(l.logged_at)}</div>
        </div>`).join('')}
    </div>`).join('')}

  ${notLogged.length ? `
    <div class="card">
      <h2 style="margin-bottom:10px">Did not log on this day</h2>
      ${notLogged.map(u => `
        <div class="name-dot" style="padding:7px 0;border-bottom:1px solid var(--line)">
          <span class="dot" style="background:var(--line)"></span>
          <div>
            <div style="font-size:13.5px;font-weight:500">${esc(u.name)}</div>
            <div class="small muted">${esc(u.department || '')} · ${u.company === 'VTX' ? 'Vertex' : u.company === 'VSN' ? 'Vision' : 'Both'}</div>
          </div>
        </div>`).join('')}
    </div>` : ''}`;
}

// ── CHANGE PASSWORD ───────────────────────────────────────────────────────────
async function renderChangePassword() {
  const main = document.getElementById('main');
  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Change password</h1><div class="sub">Update your account password</div></div>
  </div>
  <div class="card" style="max-width:440px">
    <form id="pw-form" onsubmit="submitChangePassword(event)">
      <div class="fld">
        <label>Current password</label>
        <input id="pw-cur" type="password" required placeholder="Enter current password">
      </div>
      <div class="fld">
        <label>New password</label>
        <input id="pw-new" type="password" required minlength="6" placeholder="Min 6 characters">
      </div>
      <div class="fld">
        <label>Confirm new password</label>
        <input id="pw-confirm" type="password" required minlength="6" placeholder="Repeat new password">
      </div>
      <button type="submit" class="btn btn-amber">Update password</button>
    </form>
  </div>`;
}

async function submitChangePassword(e) {
  e.preventDefault();
  const cur     = document.getElementById('pw-cur').value;
  const newPw   = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  if (newPw !== confirm) {
    toast('New passwords do not match', 'error');
    return;
  }
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const result = await api('PUT', '/users/me/password', { current_password: cur, new_password: newPw });
    if (result === null) return;
    toast('Password updated ✓', 'success');
    e.target.reset();
  } catch (ex) {
    toast(ex.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── EDIT TASK (admin) ─────────────────────────────────────────────────────────
async function renderEditTask(id) {
  const main = document.getElementById('main');
  const [task, users] = await Promise.all([
    api('GET', `/tasks/${id}`),
    api('GET', '/users'),
  ]);
  if (!task) { main.innerHTML = '<div class="error-msg">Task not found</div>'; return; }

  const emps = (users || []).filter(u => u.role === 'employee' && u.active);

  main.innerHTML = `
  <button class="backlink" onclick="openTask(${id})">← Back to task</button>
  <div class="pagehead" style="margin-top:10px">
    <div><h1>Edit task</h1><div class="sub">${esc(task.code)} · ${esc(task.title)}</div></div>
  </div>
  <div class="card" style="max-width:660px">
    <form id="edit-task-form" onsubmit="submitEditTask(event,${id})">
      <div class="fld">
        <label>Task title</label>
        <input id="et-title" value="${esc(task.title)}" required>
      </div>
      <div class="fld">
        <label>Description</label>
        <textarea id="et-desc" rows="3">${esc(task.description || '')}</textarea>
      </div>
      <div class="row">
        <div class="fld">
          <label>Priority</label>
          <select id="et-pr">
            <option value="high" ${task.priority === 'high' ? 'selected' : ''}>High</option>
            <option value="medium" ${task.priority === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="low" ${task.priority === 'low' ? 'selected' : ''}>Low</option>
          </select>
        </div>
        <div class="fld">
          <label>Deadline</label>
          <input id="et-due" type="date" value="${task.due_date ? task.due_date.slice(0, 10) : ''}">
        </div>
      </div>
      <div class="row">
        <div class="fld">
          <label>Status</label>
          <select id="et-st">
            <option value="not_started" ${task.status === 'not_started' ? 'selected' : ''}>Not started</option>
            <option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>In progress</option>
            <option value="blocked" ${task.status === 'blocked' ? 'selected' : ''}>Blocked</option>
            <option value="completed" ${task.status === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
        </div>
        <div class="fld">
          <label>Assigned to</label>
          <select id="et-emp">
            ${emps.map(u =>
              `<option value="${u.id}" ${u.id === task.assignee_id ? 'selected' : ''}>${esc(u.name)} — ${esc(u.department || '')}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="submit" class="btn btn-amber">Save changes</button>
        <button type="button" class="btn btn-ghost" onclick="openTask(${id})">Cancel</button>
      </div>
    </form>
  </div>`;
}

async function submitEditTask(e, id) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('PUT', `/tasks/${id}`, {
      title:       document.getElementById('et-title').value.trim(),
      description: document.getElementById('et-desc').value.trim() || null,
      priority:    document.getElementById('et-pr').value,
      due_date:    document.getElementById('et-due').value || null,
      status:      document.getElementById('et-st').value,
      assignee_id: +document.getElementById('et-emp').value,
    });
    toast('Task updated ✓', 'success');
    openTask(id);
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── Threaded comments helpers ─────────────────────────────────────────────────
function stopCommentPolling() {
  if (G.commentPoll) { clearInterval(G.commentPoll); G.commentPoll = null; }
}

function startCommentPolling(taskId) {
  stopCommentPolling();
  G.commentPoll = setInterval(async () => {
    if (G.view !== 'detail' || G.detailId !== taskId) { stopCommentPolling(); return; }
    const list = document.getElementById('comments-list');
    if (!list) { stopCommentPolling(); return; }
    try {
      const comments = await api('GET', `/comments?task_id=${taskId}`);
      if (!comments) return;
      const replyMap = {};
      comments.filter(c => c.parent_id).forEach(c => {
        (replyMap[c.parent_id] = replyMap[c.parent_id] || []).push(c);
      });
      const empty = list.querySelector('.muted.small');
      for (const c of comments.filter(c => !c.parent_id)) {
        const existing = list.querySelector(`[data-comment-id="${c.id}"]`);
        if (!existing) {
          if (empty) empty.remove();
          const wrapper = document.createElement('div');
          wrapper.innerHTML = commentHtml(c, replyMap, taskId);
          list.appendChild(wrapper.firstElementChild);
        } else {
          for (const r of (replyMap[c.id] || [])) {
            if (!existing.querySelector(`[data-reply-id="${r.id}"]`)) {
              const replyEl = document.createElement('div');
              replyEl.innerHTML = `
                <div class="comment" data-reply-id="${r.id}" style="margin-left:20px;margin-top:6px;padding-left:12px;border-left:2px solid var(--line)">
                  <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:2px">
                    ${r.user_role === 'employee' ? workUpdateBadge() : ''}
                    <b style="color:${userColor(r.user_id)}">${esc(r.user_name || '')}</b>
                    <span class="t">${fmtDateTime(r.created_at)}</span>
                  </div>
                  <div style="margin-top:4px">${esc(r.text)}</div>
                </div>`;
              const box = document.getElementById(`reply-box-${c.id}`);
              if (box) box.insertAdjacentElement('afterend', replyEl.firstElementChild);
              else existing.appendChild(replyEl.firstElementChild);
            }
          }
        }
      }
    } catch (e) { /* ignore transient poll errors */ }

    // Check for collaborator / assignee changes
    try {
      const fresh = await api('GET', `/tasks/${taskId}`);
      if (!fresh) return;

      // Assignee changed
      const assigneeEl = document.getElementById('team-assignee-name');
      if (assigneeEl && assigneeEl.dataset.assigneeId !== String(fresh.assignee_id)) {
        const panel = document.getElementById('task-team-panel');
        if (panel) panel.innerHTML = buildTeamPanel(fresh, G.me);
      }

      // Collaborators changed
      const collabEl = document.getElementById('task-team-panel');
      if (collabEl) {
        const currentIds = [...collabEl.querySelectorAll('[data-collab-id]')]
          .map(el => el.dataset.collabId).sort().join(',');
        const freshIds   = (fresh.collaborators || []).map(c => String(c.id)).sort().join(',');
        if (currentIds !== freshIds) {
          collabEl.innerHTML = buildTeamPanel(fresh, G.me);
        }
      }
    } catch (e) { /* ignore */ }
  }, 5000);
}

function buildTeamPanel(task, me) {
  const canManage    = me.role === 'admin' || task.assignee_id === me.id;
  const collabCount  = (task.collaborators || []).length;
  const atLimit      = me.role !== 'admin' && collabCount >= 3;
  const allUsers     = G._detailUsers || [];
  const available    = allUsers.filter(u =>
    u.id !== task.assignee_id && !(task.collaborators || []).some(c => c.id === u.id)
  );
  const collabSel = canManage && available.length && !atLimit
    ? `<div style="display:flex;gap:8px;margin-top:8px">
        <select id="collab-sel" style="flex:1;margin:0">
          <option value="">Add collaborator…</option>
          ${available.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" onclick="addCollaborator(${task.id})">Add</button>
       </div>`
    : (canManage && atLimit
        ? `<div class="small" style="margin-top:8px;color:var(--ink-soft)">Maximum 3 collaborators reached.</div>`
        : '');
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0"
         id="team-assignee-name" data-assignee-id="${task.assignee_id}">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="collab-av" style="background:var(--navy)">${initials(task.assignee_name)}</div>
        <span style="font-size:13.5px">${esc(task.assignee_name || '—')}</span>
      </div>
      <span style="font-size:11px;font-weight:600;color:var(--ink-soft)">Assignee</span>
    </div>
    ${(task.collaborators || []).map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0"
           data-collab-id="${c.id}">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="collab-av">${initials(c.name)}</div>
          <span style="font-size:13.5px">${esc(c.name)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:11px;font-weight:600;color:var(--accent)">Collaborator</span>
          ${canManage ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);padding:2px 6px;font-size:13px;line-height:1" title="Remove collaborator" onclick="removeCollaborator(${task.id},${c.id})">🗑</button>` : ''}
        </div>
      </div>`).join('')}
    ${!(task.collaborators || []).length ? '<div class="muted small" style="padding:2px 0 6px">No collaborators yet</div>' : ''}
    ${collabSel}`;
}

function workUpdateBadge() {
  return `<span style="font-size:11px;font-weight:600;color:#fff;background:var(--green);padding:2px 7px;border-radius:4px">Work update</span>`;
}

function commentHtml(c, replyMap, taskId) {
  const isEmp = c.user_role === 'employee';
  const replies = (replyMap[c.id] || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return `
    <div class="comment" data-comment-id="${c.id}">
      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:2px">
        ${isEmp ? workUpdateBadge() : ''}
        <b style="color:${userColor(c.user_id)}">${esc(c.user_name || '')}</b>
        <span class="t">${fmtDateTime(c.created_at)}</span>
      </div>
      <div style="margin-top:4px">${esc(c.text)}</div>
      ${attachmentChips(c.attachments || [])}
      <button onclick="showReplyBox(${c.id},${taskId})"
        style="background:none;border:none;color:var(--accent);font-size:11px;cursor:pointer;padding:3px 0;font-weight:600">
        ↩ Reply
      </button>
      <div id="reply-box-${c.id}"></div>
      ${replies.map(r => `
        <div class="comment" data-reply-id="${r.id}" style="margin-left:20px;margin-top:6px;padding-left:12px;border-left:2px solid var(--line)">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:2px">
            ${r.user_role === 'employee' ? workUpdateBadge() : ''}
            <b style="color:${userColor(r.user_id)}">${esc(r.user_name || '')}</b>
            <span class="t">${fmtDateTime(r.created_at)}</span>
          </div>
          <div style="margin-top:4px">${esc(r.text)}</div>
        </div>`).join('')}
    </div>`;
}

function showReplyBox(commentId, taskId) {
  const box = document.getElementById(`reply-box-${commentId}`);
  if (!box) return;
  if (box.innerHTML.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div style="margin-top:8px;margin-left:20px">
      <input id="ri-${commentId}" placeholder="Write a reply…"
        style="width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;margin-bottom:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span id="ri-file-name-${commentId}">Attach file</span>
          <input type="file" id="ri-file-${commentId}" style="display:none" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp" onchange="updateFileLabel('ri-file-${commentId}','ri-file-name-${commentId}')">
        </label>
        <button class="btn btn-sm" style="margin-left:auto" onclick="submitReply(${taskId},${commentId},'ri-${commentId}')">Post</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('reply-box-${commentId}').innerHTML=''">Cancel</button>
      </div>
    </div>`;
  document.getElementById(`ri-${commentId}`)?.focus();
}

async function submitReply(taskId, parentId, inputId) {
  const el        = document.getElementById(inputId);
  const fileInput = document.getElementById(`ri-file-${parentId}`);
  if (!el?.value.trim()) return;
  const btn = el.nextElementSibling.querySelector('.btn:not(.btn-ghost)');
  btn.disabled = true;
  try {
    const r = await api('POST', '/comments', { task_id: taskId, text: el.value.trim(), parent_id: parentId });
    if (!r) return;
    if (fileInput?.files[0]) {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        const resp = await fetch(`/api/attachments/comment/${r.id}`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${G.token}` }, body: fd,
        });
        if (resp.ok) r.attachments = [await resp.json()];
      } catch (_) {}
    }
    const box = document.getElementById(`reply-box-${parentId}`);
    const replyEl = document.createElement('div');
    replyEl.innerHTML = `
      <div class="comment" data-reply-id="${r.id}" style="margin-left:20px;margin-top:6px;padding-left:12px;border-left:2px solid var(--line)">
        <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:2px">
          ${r.user_role === 'employee' ? workUpdateBadge() : ''}
          <b style="color:${userColor(r.user_id)}">${esc(r.user_name || '')}</b>
          <span class="t">${fmtDateTime(r.created_at)}</span>
        </div>
        <div style="margin-top:4px">${esc(r.text)}</div>
        ${attachmentChips(r.attachments || [])}
      </div>`;
    if (box) {
      box.insertAdjacentElement('afterend', replyEl.firstElementChild);
      box.innerHTML = '';
    }
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── Attachment helpers ────────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fileTypeLabel(mime) {
  if (!mime) return 'FILE';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('word') || mime.includes('msword')) return 'DOC';
  if (mime.includes('excel') || mime.includes('spreadsheet')) return 'XLS';
  if (mime.startsWith('image/')) return 'IMG';
  return 'FILE';
}

function attachmentChips(attachments) {
  if (!attachments || !attachments.length) return '';
  return `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px">
    ${attachments.map(a => `
      <button onclick="downloadAttachment(${a.id})" style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--line);border-radius:4px;background:#fff;font-size:12px;cursor:pointer;color:var(--ink)">
        <span style="font-size:10px;font-weight:700;color:var(--accent)">${fileTypeLabel(a.mime_type)}</span>
        ${esc(a.original_name)}
        <span class="muted" style="font-size:11px">${fmtSize(a.file_size)}</span>
      </button>`).join('')}
  </div>`;
}

function updateFileLabel(inputId, labelId) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (label && input?.files[0]) label.textContent = input.files[0].name;
}

async function uploadAttachment(taskId, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    toast('File too large — maximum 20 MB', 'error');
    input.value = '';
    return;
  }
  const label = input.closest('label');
  if (label) label.style.opacity = '0.5';
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch(`/api/attachments/task/${taskId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${G.token}` },
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed');
    toast('File attached', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    input.value = '';
    if (label) label.style.opacity = '';
  }
}

async function downloadAttachment(id) {
  try {
    const r = await fetch(`/api/attachments/${id}/download`, {
      headers: { 'Authorization': `Bearer ${G.token}` }
    });
    if (!r.ok) throw new Error('Download failed');
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : 'download';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

async function deleteAttachment(id, taskId) {
  if (!confirm('Remove this attachment?')) return;
  try {
    await api('DELETE', `/attachments/${id}`);
    toast('Attachment removed', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

// ── ATTENDANCE — shared helpers ────────────────────────────────────────────────
const ATT_OFFICE_LAT = 31.441300523433583;
const ATT_OFFICE_LNG = 74.32441912480384;
const ATT_ALLOWED_M  = 100;

function attHaversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function attFmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit', hour12: true });
}

function attDuration(from, to) {
  if (!from) return '—';
  const ms = (to ? new Date(to) : new Date()) - new Date(from);
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function attMonthLabel(m) {
  return new Date(m + '-01T00:00:00').toLocaleDateString('en-GB',
    { month: 'long', year: 'numeric' });
}

function attPrevMonth(m) {
  const d = new Date(m + '-01T00:00:00');
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function attNextMonth(m) {
  const d = new Date(m + '-01T00:00:00');
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 7);
}

function attStatusBadge(rec) {
  if (!rec) return `<span class="att-badge att-absent">Absent</span>`;
  if (rec.approval_status === 'pending')  return `<span class="att-badge att-pending">Pending</span>`;
  if (rec.approval_status === 'rejected') return `<span class="att-badge att-rejected">Rejected</span>`;
  if (rec.status === 'halfday') return `<span class="att-badge att-halfday">Half Day</span>`;
  if (rec.status === 'late')    return `<span class="att-badge att-late">Late</span>`;
  if (rec.status === 'present') return `<span class="att-badge att-present">Present</span>`;
  return `<span class="att-badge att-absent">Absent</span>`;
}

// Build a row of day-cells for a month calendar
function attCalendarRow(records, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = TODAY();
  const byDate = {};
  (records || []).forEach(r => { byDate[r.date.slice(0, 10)] = r; });

  const DAY_NAMES = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  let hdr = '', cells = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const ds  = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(ds + 'T00:00:00').getDay();
    const rec = byDate[ds];
    const isWeekend = dow === 0;
    const isFuture  = ds > today;
    const isToday   = ds === today;

    let cls = 'att-cal-cell';
    if (isFuture)                                                              cls += ' att-cal-future';
    else if (rec && rec.approval_status === 'pending')                         cls += ' att-cal-pending';
    else if (rec && rec.approval_status === 'rejected')                        cls += ' att-cal-rejected';
    else if (rec && rec.approval_status === 'approved' && rec.status === 'halfday') cls += ' att-cal-halfday';
    else if (rec && rec.approval_status === 'approved' && rec.status === 'late')    cls += ' att-cal-late';
    else if (rec && rec.approval_status === 'approved')                        cls += ' att-cal-present';
    else if (isWeekend)                                                        cls += ' att-cal-off';
    else                                                                       cls += ' att-cal-absent';
    if (isToday) cls += ' att-cal-today';

    const title = isWeekend ? 'Weekend' : !rec && !isFuture ? 'Absent'
      : rec ? `${rec.status} — In: ${attFmtTime(rec.check_in_at)} Out: ${attFmtTime(rec.check_out_at)}`
      : '';

    hdr   += `<div class="att-cal-hdr">${d}<div class="att-cal-dow">${DAY_NAMES[dow]}</div></div>`;
    cells += `<div class="${cls}" title="${esc(title)}"></div>`;
  }
  return { hdr, cells, daysInMonth };
}

// ── ATTENDANCE — Employee view ─────────────────────────────────────────────────
async function renderAttendance() {
  const main  = document.getElementById('main');
  const month = G.attMonth || TODAY().slice(0, 7);
  G.attMonth  = month;

  const [todayRec, monthRecs, deviceInfo] = await Promise.all([
    api('GET', '/attendance/today'),
    api('GET', `/attendance/my?month=${month}`),
    api('GET', '/webauthn/device').catch(() => null),
  ]);
  G._attDevice = deviceInfo;

  const today     = TODAY();
  const approved  = (monthRecs || []).filter(r => r.approval_status === 'approved');
  const present   = approved.filter(r => r.status === 'present').length;
  const late      = approved.filter(r => r.status === 'late').length;
  const halfday   = approved.filter(r => r.status === 'halfday').length;
  const lateAbsents    = Math.floor(late / 3);
  const halfdayAbsents = Math.floor(halfday / 2);
  const { y: cy, m: cm } = (() => { const [y,m] = month.split('-'); return {y,m}; })();
  const daysInMonth = new Date(parseInt(cy), parseInt(cm), 0).getDate();
  let elapsedWork = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${cy}-${String(cm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (ds > today) break;
    if (new Date(ds + 'T00:00:00').getDay() !== 0) elapsedWork++;
  }
  const absent = Math.max(0, elapsedWork - present - late - halfday) + lateAbsents + halfdayAbsents;

  // Warning banners
  const warnings = [];
  if (late === 1)      warnings.push(`<div class="att-warn">You have <b>1 late arrival</b> this month — 2 more will count as 1 absent day.</div>`);
  else if (late === 2) warnings.push(`<div class="att-warn att-warn-red">You have <b>2 late arrivals</b> this month — 1 more will count as 1 absent day!</div>`);
  else if (late >= 3)  warnings.push(`<div class="att-warn att-warn-red">You have <b>${late} late arrivals</b> this month — every 3 lates = 1 absent day. That's <b>${lateAbsents}</b> absent day(s) from lates.</div>`);
  if (halfday === 1)      warnings.push(`<div class="att-warn">You have <b>1 half day</b> this month — 1 more will count as 1 absent day.</div>`);
  else if (halfday >= 2)  warnings.push(`<div class="att-warn att-warn-red">You have <b>${halfday} half days</b> this month — every 2 half days = 1 absent day. That's <b>${halfdayAbsents}</b> absent day(s) from half days.</div>`);
  const lateWarning = warnings.join('');

  // Today panel
  let todayPanel = '';
  const hasApprovedDevice = deviceInfo?.status === 'approved';
  if (!todayRec) {
    if (hasApprovedDevice) {
      todayPanel = `
        <div class="att-checkin-card" id="att-checkin-card">
          <div class="att-device-badge att-device-approved">
            <span>🔐</span> Registered device active — biometric check-in required
          </div>
          <div class="att-checkin-status" id="att-loc-status" style="margin-top:12px">
            <div class="att-loc-icon">📍</div>
            <div id="att-loc-text" class="muted">Checking your location…</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <button class="btn btn-amber" id="att-checkin-btn" disabled onclick="attWebAuthnCheckin()">
              Biometric Check-In
            </button>
          </div>
        </div>`;
    } else {
      todayPanel = `
        <div class="att-checkin-card" id="att-checkin-card">
          ${deviceInfo?.status === 'pending' ? `<div class="att-device-badge att-device-pending"><span>⏳</span> Device registration pending admin approval</div>` : ''}
          <div class="att-checkin-status" id="att-loc-status" style="margin-top:${deviceInfo?.status === 'pending' ? '10' : '0'}px">
            <div class="att-loc-icon">📍</div>
            <div id="att-loc-text" class="muted">Checking your location…</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <button class="btn btn-amber" id="att-checkin-btn" disabled onclick="attDoCheckin('location')">
              Check In
            </button>
            <button class="btn btn-ghost" onclick="attShowManualCheckin()">
              Request Manual Check-In
            </button>
          </div>
          <div id="att-manual-form" style="display:none;margin-top:14px">
            <div class="fld">
              <label>Reason (will be sent to admin for approval)</label>
              <textarea id="att-manual-remark" rows="2" placeholder="e.g. Phone GPS not working, please verify via CCTV"></textarea>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-amber btn-sm" onclick="attDoCheckin('manual')">Submit Request</button>
              <button class="btn btn-ghost btn-sm" onclick="attHideManualCheckin()">Cancel</button>
            </div>
          </div>
        </div>`;}
  } else if (todayRec.approval_status === 'pending' && !todayRec.check_out_at) {
    todayPanel = `
      <div class="att-checkin-card att-card-pending" id="att-checkin-card">
        <div class="att-pending-msg">
          <span class="att-badge att-pending" style="font-size:13px;padding:4px 12px">Check-in pending approval</span>
          <span style="margin-left:10px;font-size:13.5px">Your manual check-in is awaiting admin approval.</span>
        </div>
        <div class="att-time-row" style="margin-top:8px">
          <span class="muted small">Submitted at</span>
          <span style="margin-left:8px">${attFmtTime(todayRec.check_in_at)}</span>
        </div>
        ${todayRec.checkout_remark ? `<div class="att-remark muted small" style="margin-top:4px">"${esc(todayRec.checkout_remark)}"</div>` : ''}
        <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:14px">
          <div class="muted small" style="margin-bottom:10px">You can still check out — admin will review both together.</div>
          <div class="att-checkin-status" id="att-loc-status">
            <div class="att-loc-icon">📍</div>
            <div id="att-loc-text" class="muted">Checking your location…</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
            ${hasApprovedDevice
              ? `<button class="btn btn-sm" style="background:var(--red);color:#fff" id="att-checkout-btn" onclick="attWebAuthnCheckout()">Biometric Check-Out</button>`
              : `<button class="btn btn-sm" style="background:var(--red);color:#fff" id="att-checkout-btn" disabled onclick="attDoCheckout('location')">Check Out</button>
                 <button class="btn btn-ghost btn-sm" onclick="attShowOooForm()">Early Leave / Remote Check-Out</button>`}
          </div>
          ${!hasApprovedDevice ? `<div id="att-ooo-form" style="display:none;margin-top:12px">
            <div class="fld">
              <label>Reason for early leave or remote checkout (required)</label>
              <textarea id="att-ooo-remark" rows="2" placeholder="e.g. Left early for doctor appointment, working remotely"></textarea>
            </div>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-sm" style="background:var(--red);color:#fff" onclick="attDoCheckout('out_of_office')">Submit</button>
              <button class="btn btn-ghost btn-sm" onclick="attHideOooForm()">Cancel</button>
            </div>
          </div>` : ''}
        </div>
      </div>`;
  } else if (todayRec.check_in_at && !todayRec.check_out_at) {
    const ciType = todayRec.check_in_type;
    todayPanel = `
      <div class="att-checkin-card att-card-in" id="att-checkin-card">
        <div class="att-time-row">
          <div>
            <div class="att-badge att-present" style="margin-bottom:6px">${todayRec.status === 'late' ? '⏰ Checked in (Late)' : '✓ Checked In'}</div>
            <div style="font-size:22px;font-weight:700;letter-spacing:-0.5px">${attFmtTime(todayRec.check_in_at)}</div>
            <div class="muted small" style="margin-top:2px">Duration: <span id="att-duration-live">${attDuration(todayRec.check_in_at, null)}</span></div>
          </div>
        </div>
        ${hasApprovedDevice
          ? `<div class="att-device-badge att-device-approved" style="margin-top:12px"><span>🔐</span> Biometric check-out required</div>`
          : `<div class="att-checkin-status" id="att-loc-status" style="margin-top:12px">
               <div class="att-loc-icon">📍</div>
               <div id="att-loc-text" class="muted">Checking your location…</div>
             </div>`}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          ${hasApprovedDevice
            ? `<button class="btn" style="background:var(--red);color:#fff" id="att-checkout-btn" onclick="attWebAuthnCheckout()">Biometric Check-Out</button>`
            : `<button class="btn" style="background:var(--red);color:#fff" id="att-checkout-btn" disabled onclick="attDoCheckout('location')">Check Out</button>
               <button class="btn btn-ghost" onclick="attShowOooForm()">Early Leave / Remote Check-Out</button>`}
        </div>
        ${!hasApprovedDevice ? `<div id="att-ooo-form" style="display:none;margin-top:14px">
          <div class="fld">
            <label>Reason for early leave or remote checkout (required)</label>
            <textarea id="att-ooo-remark" rows="2" placeholder="e.g. Left early for doctor appointment, working remotely"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-sm" style="background:var(--red);color:#fff" onclick="attDoCheckout('out_of_office')">Submit</button>
            <button class="btn btn-ghost btn-sm" onclick="attHideOooForm()">Cancel</button>
          </div>
        </div>` : ''}
      </div>`;
  } else if (todayRec.check_out_at) {
    const outPending = todayRec.approval_status === 'pending';
    todayPanel = `
      <div class="att-checkin-card att-card-done">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div>
            <div class="muted small">Check In</div>
            <div style="font-size:18px;font-weight:700">${attFmtTime(todayRec.check_in_at)}</div>
          </div>
          <div>
            <div class="muted small">Check Out</div>
            <div style="font-size:18px;font-weight:700">${attFmtTime(todayRec.check_out_at)}</div>
          </div>
          <div>
            <div class="muted small">Duration</div>
            <div style="font-size:18px;font-weight:700">${attDuration(todayRec.check_in_at, todayRec.check_out_at)}</div>
          </div>
        </div>
        ${outPending ? `<div class="att-warn" style="margin-top:10px">Your out-of-office checkout is <b>pending admin approval</b>.</div>` : ''}
        ${todayRec.checkout_remark ? `<div class="att-remark muted small" style="margin-top:6px">Remark: "${esc(todayRec.checkout_remark)}"</div>` : ''}
      </div>`;
  }

  const cal = attCalendarRow(monthRecs, month);
  const isCurrentMonth = month === TODAY().slice(0, 7);
  const canGoNext = month < TODAY().slice(0, 7);

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>My Attendance</h1>
    <div class="sub">${new Date().toLocaleDateString('en-GB',
      { weekday:'long', day:'numeric', month:'long', year:'numeric' })}</div></div>
  </div>

  ${lateWarning}

  <div class="att-today-section">
    <div class="att-section-title">Today</div>
    ${todayPanel}
  </div>

  <div class="att-month-nav">
    <button class="btn btn-ghost btn-sm" onclick="G.attMonth='${attPrevMonth(month)}';renderView()">← Prev</button>
    <span class="att-month-label">${attMonthLabel(month)}</span>
    <button class="btn btn-ghost btn-sm" ${!canGoNext ? 'disabled' : ''} onclick="G.attMonth='${attNextMonth(month)}';renderView()">Next →</button>
  </div>

  <div class="att-stats-row">
    <div class="att-stat att-stat-present"><div class="att-stat-num">${present}</div><div class="att-stat-lbl">Present</div></div>
    <div class="att-stat att-stat-late"><div class="att-stat-num">${late}</div><div class="att-stat-lbl">Late</div></div>
    <div class="att-stat att-stat-halfday"><div class="att-stat-num">${halfday}</div><div class="att-stat-lbl">Half Day</div></div>
    <div class="att-stat att-stat-absent"><div class="att-stat-num">${absent}</div><div class="att-stat-lbl">Absent</div></div>
    <div class="att-stat att-stat-work"><div class="att-stat-num">${elapsedWork}</div><div class="att-stat-lbl">Working days</div></div>
  </div>

  <div class="card" style="overflow-x:auto;padding:12px 10px">
    <div class="att-cal-wrap" style="min-width:${cal.daysInMonth * 34}px">
      <div class="att-cal-grid" style="grid-template-columns:repeat(${cal.daysInMonth},1fr)">
        ${cal.hdr}
      </div>
      <div class="att-cal-grid" style="grid-template-columns:repeat(${cal.daysInMonth},1fr);margin-top:4px">
        ${cal.cells}
      </div>
    </div>
    <div class="att-cal-legend">
      <span><span class="att-cal-cell att-cal-present att-legend-cell"></span>Present</span>
      <span><span class="att-cal-cell att-cal-late att-legend-cell"></span>Late</span>
      <span><span class="att-cal-cell att-cal-halfday att-legend-cell"></span>Half Day</span>
      <span><span class="att-cal-cell att-cal-absent att-legend-cell"></span>Absent</span>
      <span><span class="att-cal-cell att-cal-pending att-legend-cell"></span>Pending</span>
      <span><span class="att-cal-cell att-cal-off att-legend-cell"></span>Weekend</span>
    </div>
  </div>

  ${attDevicePanel(deviceInfo)}

  <div class="card" style="margin-top:14px">
    <h2 style="margin-bottom:12px">Log — ${attMonthLabel(month)}</h2>
    ${(monthRecs || []).length === 0
      ? '<div class="empty muted">No records this month</div>'
      : `<div style="overflow-x:auto"><table class="att-table">
          <thead><tr>
            <th>Date</th><th>Status</th><th>Check In</th><th>Check Out</th>
            <th>Duration</th><th>Type</th><th>Remarks</th>
          </tr></thead>
          <tbody>
            ${(monthRecs || []).slice().reverse().map(r => `
              <tr>
                <td>${fmt(r.date)}</td>
                <td>${attStatusBadge(r)}</td>
                <td>${attFmtTime(r.check_in_at)}</td>
                <td>${attFmtTime(r.check_out_at)}</td>
                <td>${attDuration(r.check_in_at, r.check_out_at)}</td>
                <td class="muted small">${
                  r.check_in_type === 'location' ? 'GPS' :
                  r.check_in_type === 'manual'   ? 'Manual' :
                  r.check_in_type === 'webauthn' ? '🔐 Biometric' : '—'
                }${r.check_out_type ? ' / ' + (
                  r.check_out_type === 'location'      ? 'GPS' :
                  r.check_out_type === 'out_of_office' ? 'Early leave' :
                  r.check_out_type === 'manual'        ? 'Manual' :
                  r.check_out_type === 'webauthn'      ? '🔐 Biometric' : r.check_out_type
                ) : ''}</td>
                <td class="muted small">${esc(r.checkout_remark || r.admin_note || '')}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>`}
  </div>`;

  // Start location check
  attCheckLocation('att-loc-status', 'att-loc-text', todayRec);

  // Live duration counter when checked in
  if (todayRec?.check_in_at && !todayRec.check_out_at) {
    G._attDurationTimer = setInterval(() => {
      const el = document.getElementById('att-duration-live');
      if (el) el.textContent = attDuration(todayRec.check_in_at, null);
      else clearInterval(G._attDurationTimer);
    }, 30000);
  }
}

function attCheckLocation(statusId, textId, todayRec) {
  const statusEl = document.getElementById(statusId);
  const textEl   = document.getElementById(textId);
  const checkinBtn  = document.getElementById('att-checkin-btn');
  const checkoutBtn = document.getElementById('att-checkout-btn');

  if (!statusEl) return;
  if (!navigator.geolocation) {
    if (textEl) textEl.textContent = 'Geolocation not supported by your browser.';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      const dist = attHaversineM(
        ATT_OFFICE_LAT, ATT_OFFICE_LNG,
        pos.coords.latitude, pos.coords.longitude
      );
      const inRange = dist <= ATT_ALLOWED_M;
      if (textEl) {
        textEl.innerHTML = inRange
          ? `<span style="color:var(--green)">✓ At office (${Math.round(dist)}m away)</span>`
          : `<span style="color:var(--red)">✗ ${Math.round(dist)}m from office — location check-in unavailable</span>`;
      }
      if (statusEl) {
        statusEl.style.background = inRange ? 'var(--green-s)' : 'var(--red-s)';
        statusEl.style.borderColor = inRange ? 'var(--green)' : 'var(--red)';
      }
      if (checkinBtn  && inRange) { checkinBtn.disabled  = false; checkinBtn.dataset.lat = pos.coords.latitude; checkinBtn.dataset.lng = pos.coords.longitude; }
      if (checkoutBtn && inRange) { checkoutBtn.disabled = false; checkoutBtn.dataset.lat = pos.coords.latitude; checkoutBtn.dataset.lng = pos.coords.longitude; }
    },
    err => {
      if (textEl) textEl.textContent = 'Location access denied — use manual check-in option below.';
    },
    { timeout: 10000, maximumAge: 60000 }
  );
}

function attShowManualCheckin() {
  document.getElementById('att-manual-form').style.display = 'block';
}
function attHideManualCheckin() {
  document.getElementById('att-manual-form').style.display = 'none';
}
function attShowOooForm() {
  document.getElementById('att-ooo-form').style.display = 'block';
}
function attHideOooForm() {
  document.getElementById('att-ooo-form').style.display = 'none';
}

async function attDoCheckin(type) {
  const btn = document.getElementById('att-checkin-btn');
  let payload = { type };
  if (type === 'location') {
    payload.lat = parseFloat(btn.dataset.lat);
    payload.lng = parseFloat(btn.dataset.lng);
  } else {
    const remark = document.getElementById('att-manual-remark')?.value.trim();
    if (!remark) { toast('Please enter a reason for manual check-in', 'error'); return; }
    payload.remark = remark;
  }
  try {
    if (btn) btn.disabled = true;
    await api('POST', '/attendance/checkin', payload);
    toast(type === 'manual' ? 'Manual check-in request submitted' : 'Checked in successfully ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    if (btn) btn.disabled = false;
  }
}

async function attDoCheckout(type) {
  const btn = document.getElementById('att-checkout-btn');
  let payload = { type };
  if (type === 'location') {
    payload.lat = parseFloat(btn.dataset.lat);
    payload.lng = parseFloat(btn.dataset.lng);
  } else {
    const remark = document.getElementById('att-ooo-remark')?.value.trim();
    if (!remark) { toast('Please enter a reason for out-of-office checkout', 'error'); return; }
    payload.remark = remark;
  }
  try {
    if (btn) btn.disabled = true;
    await api('POST', '/attendance/checkout', payload);
    toast(type === 'out_of_office' ? 'Early leave / remote checkout submitted for approval' : 'Checked out successfully ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    if (btn) btn.disabled = false;
  }
}

// ── WebAuthn helpers ──────────────────────────────────────────────────────────

function attB64urlToBuffer(str) {
  const base64  = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded  = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const bin     = atob(padded);
  return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
}

function attBufferToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function attEncodeCredential(cred) {
  return {
    id:       cred.id,
    rawId:    attBufferToB64url(cred.rawId),
    type:     cred.type,
    response: {
      clientDataJSON:    attBufferToB64url(cred.response.clientDataJSON),
      attestationObject: cred.response.attestationObject ? attBufferToB64url(cred.response.attestationObject) : undefined,
      authenticatorData: cred.response.authenticatorData ? attBufferToB64url(cred.response.authenticatorData) : undefined,
      signature:         cred.response.signature         ? attBufferToB64url(cred.response.signature)         : undefined,
      userHandle:        cred.response.userHandle        ? attBufferToB64url(cred.response.userHandle)        : undefined,
      transports:        cred.response.getTransports     ? cred.response.getTransports() : undefined,
    },
  };
}

function attDecodeOptions(opts) {
  // Decode challenge and allowCredentials / user from base64url to ArrayBuffer
  if (opts.challenge)    opts.challenge    = attB64urlToBuffer(opts.challenge);
  if (opts.user?.id)     opts.user.id      = new TextEncoder().encode(String(opts.user.id));
  if (opts.allowCredentials) {
    opts.allowCredentials = opts.allowCredentials.map(c => ({ ...c, id: attB64urlToBuffer(c.id) }));
  }
  if (opts.excludeCredentials) {
    opts.excludeCredentials = opts.excludeCredentials.map(c => ({ ...c, id: attB64urlToBuffer(c.id) }));
  }
  return opts;
}

async function attGetGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error('Location access denied — cannot check in without GPS')),
      { timeout: 15000, maximumAge: 30000, enableHighAccuracy: true }
    );
  });
}

async function attWebAuthnCheckin() {
  const btn = document.getElementById('att-checkin-btn');
  if (btn) btn.disabled = true;
  try {
    const opts = await api('POST', '/webauthn/auth/options', { action: 'checkin' });
    attDecodeOptions(opts);
    const cred = await navigator.credentials.get({ publicKey: opts });
    const { lat, lng, accuracy } = await attGetGPS();
    await api('POST', '/attendance/checkin', { assertion: attEncodeCredential(cred), lat, lng, accuracy });
    toast('Checked in successfully ✓', 'success');
    renderView();
  } catch (ex) {
    const msg = ex.message || 'Biometric check-in failed';
    toast(msg.includes('aborted') || msg.includes('cancel') ? 'Check-in cancelled' : msg, 'error');
    if (btn) btn.disabled = false;
  }
}

async function attWebAuthnCheckout() {
  const btn = document.getElementById('att-checkout-btn');
  if (btn) btn.disabled = true;
  try {
    const opts = await api('POST', '/webauthn/auth/options', { action: 'checkout' });
    attDecodeOptions(opts);
    const cred = await navigator.credentials.get({ publicKey: opts });
    let gps = {};
    try { gps = await attGetGPS(); } catch (_) {}
    await api('POST', '/attendance/checkout', { assertion: attEncodeCredential(cred), ...gps });
    toast('Checked out successfully ✓', 'success');
    renderView();
  } catch (ex) {
    const msg = ex.message || 'Biometric checkout failed';
    toast(msg.includes('aborted') || msg.includes('cancel') ? 'Checkout cancelled' : msg, 'error');
    if (btn) btn.disabled = false;
  }
}

async function attRegisterDevice() {
  const nameInput = document.getElementById('att-device-name');
  const deviceName = nameInput?.value.trim() || 'My Phone';
  const btn = document.getElementById('att-reg-btn');
  if (btn) btn.disabled = true;
  try {
    const opts = await api('POST', '/webauthn/register/options', {});
    attDecodeOptions(opts);
    const cred = await navigator.credentials.create({ publicKey: opts });
    await api('POST', '/webauthn/register/verify', { response: attEncodeCredential(cred), deviceName });
    toast('Device registered — awaiting admin approval', 'success');
    G._attDevice = null;
    renderView();
  } catch (ex) {
    const msg = ex.message || 'Device registration failed';
    toast(msg.includes('aborted') || msg.includes('cancel') ? 'Registration cancelled' : msg, 'error');
    if (btn) btn.disabled = false;
  }
}

async function attRequestDeviceReplace() {
  const reason = prompt('Why do you need to replace your device? (e.g. Lost phone, changed phone)');
  if (!reason?.trim()) return;
  try {
    await api('POST', '/webauthn/device/replace', { reason });
    toast('Replacement requested — you can now register your new device', 'success');
    G._attDevice = null;
    renderView();
  } catch (ex) { toast(ex.message, 'error'); }
}

function attDevicePanel(device) {
  if (!device) {
    return `
    <div class="card att-device-card" style="margin-top:14px">
      <h2 style="margin-bottom:6px">Registered Device</h2>
      <p class="muted small" style="margin-bottom:14px">Register your phone or tablet to enable secure biometric check-in. Admin must approve before it activates.</p>
      <div class="fld" style="margin-bottom:10px">
        <label>Device name (optional)</label>
        <input id="att-device-name" type="text" placeholder="e.g. My Samsung S24" style="max-width:300px">
      </div>
      <button class="btn btn-sm btn-amber" id="att-reg-btn" onclick="attRegisterDevice()">Register This Device</button>
    </div>`;
  }
  if (device.status === 'pending') {
    return `
    <div class="card att-device-card" style="margin-top:14px">
      <h2 style="margin-bottom:6px">Registered Device</h2>
      <div class="att-device-badge att-device-pending" style="margin-bottom:10px"><span>⏳</span> <b>${esc(device.device_name)}</b> — pending admin approval</div>
      <div class="muted small">Registered on ${new Date(device.registered_at).toLocaleDateString()}. You can still use GPS check-in until your device is approved.</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="attRequestDeviceReplace()">Request Replacement</button>
    </div>`;
  }
  if (device.status === 'approved') {
    return `
    <div class="card att-device-card" style="margin-top:14px">
      <h2 style="margin-bottom:6px">Registered Device</h2>
      <div class="att-device-badge att-device-approved" style="margin-bottom:10px"><span>✓</span> <b>${esc(device.device_name)}</b> — active</div>
      <div class="muted small">Approved and active. All check-ins/outs use biometric verification on this device.</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" onclick="attRequestDeviceReplace()">Request Device Replacement</button>
    </div>`;
  }
  // rejected / revoked
  return `
  <div class="card att-device-card" style="margin-top:14px">
    <h2 style="margin-bottom:6px">Registered Device</h2>
    <div class="att-device-badge att-device-revoked" style="margin-bottom:10px"><span>✗</span> Previous device ${device.status}${device.revocation_reason ? ` — ${esc(device.revocation_reason)}` : ''}</div>
    <div class="fld" style="margin-bottom:10px;margin-top:10px">
      <label>Device name (optional)</label>
      <input id="att-device-name" type="text" placeholder="e.g. My Samsung S24" style="max-width:300px">
    </div>
    <button class="btn btn-sm btn-amber" id="att-reg-btn" onclick="attRegisterDevice()">Register New Device</button>
  </div>`;
}

async function renderAttAdminDevices() {
  const body = document.getElementById('att-admin-body');
  body.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading…</span></div>';
  const devs = await api('GET', '/webauthn/admin/devices');
  if (!devs) return;

  const pending  = devs.filter(d => d.status === 'pending');
  const approved = devs.filter(d => d.status === 'approved');
  const others   = devs.filter(d => !['pending','approved'].includes(d.status));

  function devRow(d) {
    const statusBadge = d.status === 'approved'
      ? `<span class="att-badge att-present">Approved</span>`
      : d.status === 'pending'
      ? `<span class="att-badge att-pending">Pending</span>`
      : `<span class="att-badge att-rejected">${d.status}</span>`;
    const actions = d.status === 'pending'
      ? `<button class="btn btn-sm" style="background:var(--green);color:#fff" onclick="attAdminApproveDevice(${d.id})">Approve</button>
         <button class="btn btn-sm btn-ghost" onclick="attAdminRejectDevice(${d.id})">Reject</button>`
      : d.status === 'approved'
      ? `<button class="btn btn-sm btn-ghost" onclick="attAdminRevokeDevice(${d.id})">Revoke</button>`
      : '';
    return `<tr>
      <td>${esc(d.user_name)}<br><span class="muted small">${esc(d.email)}</span></td>
      <td><span class="muted small">${esc(d.company)}</span></td>
      <td>${esc(d.device_name)}<br><span class="muted small" style="font-size:11px">${esc((d.browser_info||'').slice(0,60))}</span></td>
      <td>${statusBadge}</td>
      <td class="muted small">${new Date(d.registered_at).toLocaleDateString()}</td>
      <td>${d.approved_by_name ? `<span class="muted small">${esc(d.approved_by_name)}</span>` : ''}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }

  body.innerHTML = `
  <div style="margin-top:10px">
    ${pending.length ? `
    <h3 style="margin-bottom:8px">Pending Approval (${pending.length})</h3>
    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="att-table">
        <thead><tr><th>Employee</th><th>Company</th><th>Device</th><th>Status</th><th>Registered</th><th>Approved By</th><th>Actions</th></tr></thead>
        <tbody>${pending.map(devRow).join('')}</tbody>
      </table>
    </div>` : '<div class="muted small" style="margin-bottom:16px">No pending device registrations.</div>'}

    ${approved.length ? `
    <h3 style="margin-bottom:8px">Active Devices (${approved.length})</h3>
    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="att-table">
        <thead><tr><th>Employee</th><th>Company</th><th>Device</th><th>Status</th><th>Registered</th><th>Approved By</th><th>Actions</th></tr></thead>
        <tbody>${approved.map(devRow).join('')}</tbody>
      </table>
    </div>` : ''}

    ${others.length ? `
    <h3 style="margin-bottom:8px">Inactive (${others.length})</h3>
    <div style="overflow-x:auto">
      <table class="att-table">
        <thead><tr><th>Employee</th><th>Company</th><th>Device</th><th>Status</th><th>Registered</th><th>Approved By</th><th>Actions</th></tr></thead>
        <tbody>${others.map(devRow).join('')}</tbody>
      </table>
    </div>` : ''}
  </div>`;
}

async function attAdminApproveDevice(id) {
  if (!confirm('Approve this device? Any other approved device for this employee will be revoked.')) return;
  try {
    await api('PUT', `/webauthn/admin/devices/${id}/approve`, {});
    toast('Device approved', 'success');
    renderAttAdminDevices();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function attAdminRejectDevice(id) {
  const reason = prompt('Reason for rejection (optional):') || '';
  try {
    await api('PUT', `/webauthn/admin/devices/${id}/reject`, { reason });
    toast('Device rejected', 'success');
    renderAttAdminDevices();
  } catch (ex) { toast(ex.message, 'error'); }
}

async function attAdminRevokeDevice(id) {
  const reason = prompt('Reason for revoking this device (required):');
  if (!reason?.trim()) { toast('Reason is required to revoke', 'error'); return; }
  try {
    await api('PUT', `/webauthn/admin/devices/${id}/revoke`, { reason });
    toast('Device revoked', 'success');
    renderAttAdminDevices();
  } catch (ex) { toast(ex.message, 'error'); }
}

// ── ATTENDANCE — Admin view ────────────────────────────────────────────────────
function attAdminTab(tab) {
  G._attAdminTab = tab;
  renderView();
}

async function renderAttendanceAdmin() {
  const main = document.getElementById('main');
  const tab  = G._attAdminTab || 'daily';

  // Count pending for badge
  let pendingCount = 0;
  try {
    const pending = await api('GET', '/attendance/admin/pending');
    pendingCount = (pending || []).length;
  } catch (_) {}

  let devicePendingCount = 0;
  try {
    const devs = await api('GET', '/webauthn/admin/devices');
    devicePendingCount = (devs || []).filter(d => d.status === 'pending').length;
  } catch (_) {}

  const tabs = `
  <div class="att-admin-tabs">
    <button class="${tab === 'daily'   ? 'active' : ''}" onclick="attAdminTab('daily')">Daily View</button>
    <button class="${tab === 'monthly' ? 'active' : ''}" onclick="attAdminTab('monthly')">Monthly Report</button>
    <button class="${tab === 'pending' ? 'active' : ''}" onclick="attAdminTab('pending')">
      Pending Approvals${pendingCount ? ` <span class="att-pending-badge">${pendingCount}</span>` : ''}
    </button>
    <button class="${tab === 'devices' ? 'active' : ''}" onclick="attAdminTab('devices')">
      Devices${devicePendingCount ? ` <span class="att-pending-badge">${devicePendingCount}</span>` : ''}
    </button>
  </div>`;

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Attendance</h1><div class="sub">Manage employee attendance records</div></div>
    <button class="btn btn-ghost btn-sm" onclick="attAdminExport()">Export PDF</button>
  </div>
  ${tabs}
  <div id="att-admin-body"><div class="loading"><div class="spinner"></div><span>Loading…</span></div></div>`;

  if (tab === 'daily')        renderAttAdminDaily();
  else if (tab === 'monthly') renderAttAdminMonthly();
  else if (tab === 'pending') renderAttAdminPending();
  else if (tab === 'devices') renderAttAdminDevices();
}

async function renderAttAdminDaily() {
  const body = document.getElementById('att-admin-body');
  const date = G._attAdminDate || TODAY();
  G._attAdminDate = date;

  const rows = await api('GET', `/attendance/admin/daily?date=${date}`);
  if (!rows) return;

  const vtx   = rows.filter(r => r.company === 'VTX');
  const vsn   = rows.filter(r => r.company === 'VSN');
  const other = rows.filter(r => r.company !== 'VTX' && r.company !== 'VSN');

  function buildTable(list) {
    if (!list.length) return '<div class="muted small">No employees.</div>';
    const present = list.filter(r => r.record?.approval_status === 'approved' && r.record?.status === 'present').length;
    const late    = list.filter(r => r.record?.approval_status === 'approved' && r.record?.status === 'late').length;
    const pending = list.filter(r => r.record?.approval_status === 'pending').length;
    const absent  = list.filter(r => !r.record).length;
    return `
      <div class="att-daily-summary">
        <span class="att-badge att-present">${present} Present</span>
        <span class="att-badge att-late">${late} Late</span>
        <span class="att-badge att-absent">${absent} Absent</span>
        ${pending ? `<span class="att-badge att-pending">${pending} Pending</span>` : ''}
      </div>
      <div style="overflow-x:auto"><table class="att-table">
        <thead><tr>
          <th>Employee</th><th>Dept</th><th>Status</th>
          <th>Check In</th><th>Check Out</th><th>Duration</th><th>Type</th><th>Action</th>
        </tr></thead>
        <tbody>
          ${list.map(r => `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="muted small">${esc(r.department || '—')}</td>
              <td>${attStatusBadge(r.record)}</td>
              <td>${attFmtTime(r.record?.check_in_at)}</td>
              <td>${attFmtTime(r.record?.check_out_at)}</td>
              <td>${r.record ? attDuration(r.record.check_in_at, r.record.check_out_at) : '—'}</td>
              <td class="muted small">${r.record ? (
                r.record.check_in_type === 'webauthn' ? '🔐 Biometric' :
                r.record.check_in_type === 'location' ? 'GPS' :
                r.record.check_in_type === 'manual'   ? 'Manual' :
                esc(r.record.check_in_type || '')
              ) : '—'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="attAdminMarkModal(${r.id},'${esc(r.name)}','${date}',${r.record ? r.record.id : 'null'})">
                  ${r.record ? 'Edit' : 'Mark'}
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>`;
  }

  body.innerHTML = `
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
    <label style="font-size:13px;font-weight:600">Date</label>
    <input type="date" value="${date}" max="${TODAY()}"
      style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px;background:#fff;color:var(--ink);width:auto"
      onchange="G._attAdminDate=this.value;renderAttAdminDaily()">
    <span class="muted small">${rows.length} employee(s) with attendance enabled</span>
  </div>
  ${vtx.length   ? `<div class="att-company-block"><div class="att-company-title">Vertex Electronics</div>${buildTable(vtx)}</div>` : ''}
  ${vsn.length   ? `<div class="att-company-block" style="margin-top:18px"><div class="att-company-title">Vision Engineering</div>${buildTable(vsn)}</div>` : ''}
  ${other.length ? `<div class="att-company-block" style="margin-top:18px"><div class="att-company-title">All Companies</div>${buildTable(other)}</div>` : ''}
  ${!rows.length ? '<div class="card"><div class="empty">No employees with attendance enabled.</div></div>' : ''}
  <div id="att-mark-modal" style="display:none"></div>`;
}

async function renderAttAdminMonthly() {
  const body  = document.getElementById('att-admin-body');
  const month = G._attAdminMonth || TODAY().slice(0, 7);
  G._attAdminMonth = month;

  const data = await api('GET', `/attendance/admin/monthly?month=${month}`);
  if (!data) return;

  function buildMonthTable(list) {
    if (!list.length) return '<div class="muted small">No employees.</div>';
    const cal = list[0] ? attCalendarRow([], month) : null;
    const daysInMonth = cal ? cal.daysInMonth : 31;
    return `
      <div style="overflow-x:auto">
        <table class="att-table att-monthly-table">
          <thead>
            <tr>
              <th style="min-width:140px">Employee</th>
              <th>Dept</th>
              <th style="text-align:center">Present</th>
              <th style="text-align:center">Late</th>
              <th style="text-align:center">Absent</th>
              <th colspan="${daysInMonth}" style="text-align:center;border-left:1px solid var(--line)">${attMonthLabel(month)}</th>
            </tr>
            <tr class="att-cal-header-row">
              <th></th><th></th><th></th><th></th><th></th>
              ${(() => {
                const [y, m] = month.split('-').map(Number);
                const dIM = new Date(y, m, 0).getDate();
                let ths = '';
                for (let d = 1; d <= dIM; d++) {
                  const ds  = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                  const dow = new Date(ds + 'T00:00:00').getDay();
                  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
                  ths += `<th class="att-cal-th${dow === 0 ? ' att-cal-th-off' : ''}">${d}<div style="font-size:9px;opacity:.7">${dayNames[dow]}</div></th>`;
                }
                return ths;
              })()}
            </tr>
          </thead>
          <tbody>
            ${list.map(u => {
              const today = TODAY();
              const [y, m] = month.split('-').map(Number);
              const dIM = new Date(y, m, 0).getDate();
              const byDate = {};
              (u.records || []).forEach(r => { byDate[r.date.slice(0,10)] = r; });
              let dayCells = '';
              for (let d = 1; d <= dIM; d++) {
                const ds  = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                const dow = new Date(ds + 'T00:00:00').getDay();
                const rec = byDate[ds];
                const isFuture  = ds > today;
                const isWeekend = dow === 0;
                let cls = 'att-cal-td';
                if (isFuture)                                               cls += ' att-cal-td-future';
                else if (rec && rec.approval_status === 'pending')          cls += ' att-cal-td-pending';
                else if (rec && rec.approval_status === 'approved' && rec.status === 'halfday') cls += ' att-cal-td-halfday';
                else if (rec && rec.approval_status === 'approved' && rec.status === 'late')    cls += ' att-cal-td-late';
                else if (rec && rec.approval_status === 'approved')         cls += ' att-cal-td-present';
                else if (isWeekend)                                         cls += ' att-cal-td-off';
                else                                                        cls += ' att-cal-td-absent';
                const tip = isWeekend ? '' : !rec && !isFuture ? 'Absent'
                  : rec ? `${rec.status} In:${attFmtTime(rec.check_in_at)} Out:${attFmtTime(rec.check_out_at)}`
                  : '';
                dayCells += `<td class="${cls}" title="${esc(tip)}"></td>`;
              }
              return `
                <tr>
                  <td style="font-weight:500">${esc(u.name)}</td>
                  <td class="muted small">${esc(u.department || '—')}</td>
                  <td style="text-align:center;color:var(--green);font-weight:600">${u.present}</td>
                  <td style="text-align:center;color:var(--amber);font-weight:600">${u.late}</td>
                  <td style="text-align:center;color:var(--red);font-weight:600">${u.absent}</td>
                  ${dayCells}
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  const vtx   = data.filter(u => u.company === 'VTX');
  const vsn   = data.filter(u => u.company === 'VSN');
  const other = data.filter(u => u.company !== 'VTX' && u.company !== 'VSN');

  body.innerHTML = `
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn btn-ghost btn-sm" onclick="G._attAdminMonth='${attPrevMonth(month)}';renderAttAdminMonthly()">← Prev</button>
    <span style="font-weight:600;font-size:15px">${attMonthLabel(month)}</span>
    <button class="btn btn-ghost btn-sm" ${month >= TODAY().slice(0,7) ? 'disabled' : ''} onclick="G._attAdminMonth='${attNextMonth(month)}';renderAttAdminMonthly()">Next →</button>
    <button class="btn btn-amber btn-sm" style="margin-left:auto" onclick="attAdminExport()">Export PDF</button>
  </div>
  ${vtx.length   ? `<div class="att-company-block"><div class="att-company-title">Vertex Electronics</div>${buildMonthTable(vtx)}</div>` : ''}
  ${vsn.length   ? `<div class="att-company-block" style="margin-top:18px"><div class="att-company-title">Vision Engineering</div>${buildMonthTable(vsn)}</div>` : ''}
  ${other.length ? `<div class="att-company-block" style="margin-top:18px"><div class="att-company-title">All Companies</div>${buildMonthTable(other)}</div>` : ''}
  ${!data.length ? '<div class="card"><div class="empty">No employees with attendance enabled.</div></div>' : ''}
  <div class="att-monthly-legend">
    <span><span class="att-cal-td att-cal-td-present att-legend-cell-sm"></span>Present</span>
    <span><span class="att-cal-td att-cal-td-late att-legend-cell-sm"></span>Late</span>
    <span><span class="att-cal-td att-cal-td-halfday att-legend-cell-sm"></span>Half Day</span>
    <span><span class="att-cal-td att-cal-td-absent att-legend-cell-sm"></span>Absent</span>
    <span><span class="att-cal-td att-cal-td-pending att-legend-cell-sm"></span>Pending</span>
    <span><span class="att-cal-td att-cal-td-off att-legend-cell-sm"></span>Weekend</span>
  </div>`;
}

async function renderAttAdminPending() {
  const body = document.getElementById('att-admin-body');
  const rows = await api('GET', '/attendance/admin/pending');
  if (!rows) return;

  if (!rows.length) {
    body.innerHTML = `<div class="card"><div class="empty">No pending approvals — all clear ✓</div></div>`;
    return;
  }

  body.innerHTML = `
  <div class="card">
    <h2 style="margin-bottom:4px">Pending Approvals (${rows.length})</h2>
    <div class="muted small" style="margin-bottom:16px">Review each request — check-in and check-out are shown separately where both are pending.</div>
    ${rows.map(r => {
      const coName = r.company === 'VTX' ? 'Vertex' : r.company === 'VSN' ? 'Vision' : r.company;
      const hasCheckinPending  = r.check_in_type === 'manual';
      const hasCheckoutPending = r.check_out_type === 'out_of_office' || r.check_out_type === 'manual';
      return `
      <div class="att-pend-card" id="att-pend-row-${r.id}">
        <div class="att-pend-header">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <div class="avatar-sm" style="font-size:12px">${initials(r.user_name)}</div>
            <div>
              <div style="font-weight:600;font-size:14px">${esc(r.user_name)}</div>
              <div class="muted small">${esc(coName)} · ${fmt(r.date)}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-sm" style="background:var(--green);color:#fff"
              onclick="attApprove(${r.id},'approve')">Approve All</button>
            <button class="btn btn-sm" style="background:var(--red);color:#fff"
              onclick="attApprove(${r.id},'reject')">Reject All</button>
          </div>
        </div>
        <div class="att-pend-rows">
          ${hasCheckinPending ? `
          <div class="att-pend-item">
            <div class="att-pend-item-label">
              <span class="att-badge att-pending" style="font-size:11px">Check-In</span>
              <span style="margin-left:8px;font-weight:500">${attFmtTime(r.check_in_at)}</span>
              <span class="muted small" style="margin-left:6px">· Manual request</span>
            </div>
            <div class="att-pend-reason">${r.checkin_remark ? `"${esc(r.checkin_remark)}"` : '<span class="muted" style="font-style:normal">No reason provided</span>'}</div>
          </div>` : `
          <div class="att-pend-item att-pend-item-ok">
            <div class="att-pend-item-label">
              <span style="color:var(--green);font-size:13px">✓ Check-In</span>
              <span style="margin-left:8px;font-weight:500">${attFmtTime(r.check_in_at)}</span>
              <span class="muted small" style="margin-left:6px">· GPS verified</span>
            </div>
          </div>`}
          ${r.check_out_at ? `
          <div class="att-pend-item${hasCheckoutPending ? '' : ' att-pend-item-ok'}">
            <div class="att-pend-item-label">
              ${hasCheckoutPending
                ? `<span class="att-badge att-pending" style="font-size:11px">Check-Out</span>`
                : `<span style="color:var(--green);font-size:13px">✓ Check-Out</span>`}
              <span style="margin-left:8px;font-weight:500">${attFmtTime(r.check_out_at)}</span>
              <span class="muted small" style="margin-left:6px">· ${r.check_out_type === 'out_of_office' ? 'Early leave / remote' : r.check_out_type === 'manual' ? 'Manual request' : 'GPS verified'}</span>
            </div>
            ${hasCheckoutPending ? `<div class="att-pend-reason">${r.checkout_remark ? `"${esc(r.checkout_remark)}"` : '<span class="muted" style="font-style:normal">No reason provided</span>'}</div>` : ''}
          </div>` : `
          <div class="att-pend-item" style="color:var(--ink-soft);font-size:13px;padding:10px 16px">
            — Employee has not checked out yet
          </div>`}
        </div>
        ${r.admin_note ? `<div class="muted small" style="padding:8px 14px;border-top:1px solid var(--line)">Admin note: ${esc(r.admin_note)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

async function attApprove(id, action) {
  const adminNote = action === 'reject'
    ? prompt('Reason for rejection (optional):')
    : null;
  if (action === 'reject' && adminNote === null) return; // cancelled
  try {
    await api('PUT', `/attendance/admin/approve/${id}`, { action, admin_note: adminNote || undefined });
    const row = document.getElementById(`att-pend-row-${id}`);
    if (row) row.remove();
    toast(action === 'approve' ? 'Approved ✓' : 'Rejected', action === 'approve' ? 'success' : 'error');
    // Refresh pending count in tabs
    G._attAdminTab = 'pending';
    renderAttendanceAdmin();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

function attAdminMarkModal(userId, userName, date, recId) {
  const modal = document.getElementById('att-mark-modal');
  if (!modal) return;
  modal.style.display = 'block';
  modal.innerHTML = `
  <div class="att-modal-overlay" onclick="attCloseModal()"></div>
  <div class="att-modal-box">
    <h2>${recId ? 'Edit' : 'Mark'} Attendance — ${esc(userName)}</h2>
    <div class="muted small" style="margin-bottom:14px">${date}</div>
    <form onsubmit="attSubmitMark(event,${userId},${recId || 'null'},'${date}')">
      <div class="row">
        <div class="fld">
          <label>Check In Time</label>
          <input type="time" id="att-m-in" value="09:00">
        </div>
        <div class="fld">
          <label>Check Out Time (optional)</label>
          <input type="time" id="att-m-out">
        </div>
      </div>
      <div class="fld">
        <label>Status</label>
        <select id="att-m-status">
          <option value="present">Present</option>
          <option value="late">Late</option>
          <option value="absent">Absent</option>
        </select>
      </div>
      <div class="fld">
        <label>Admin Note</label>
        <input type="text" id="att-m-note" placeholder="Reason for manual entry">
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="submit" class="btn btn-amber">Save</button>
        <button type="button" class="btn btn-ghost" onclick="attCloseModal()">Cancel</button>
      </div>
    </form>
  </div>`;
}

function attCloseModal() {
  const m = document.getElementById('att-mark-modal');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
}

async function attSubmitMark(e, userId, recId, date) {
  e.preventDefault();
  const timeIn  = document.getElementById('att-m-in').value;
  const timeOut = document.getElementById('att-m-out').value;
  const status  = document.getElementById('att-m-status').value;
  const note    = document.getElementById('att-m-note').value.trim();

  const makeTS = (t) => t ? `${date}T${t}:00+05:00` : null;

  try {
    if (recId) {
      await api('PUT', `/attendance/admin/edit/${recId}`, {
        check_in_at:     makeTS(timeIn),
        check_out_at:    makeTS(timeOut) || undefined,
        status, admin_note: note || undefined,
        approval_status: 'approved',
      });
    } else {
      await api('POST', '/attendance/admin/manual', {
        user_id: userId, date,
        check_in_at:  makeTS(timeIn),
        check_out_at: makeTS(timeOut) || undefined,
        status, admin_note: note || undefined,
      });
    }
    toast('Attendance record saved ✓', 'success');
    attCloseModal();
    renderAttAdminDaily();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

function attAdminExport() {
  const month = G._attAdminMonth || TODAY().slice(0, 7);
  const title  = `Attendance Report — ${attMonthLabel(month)}`;
  const w = window.open('', '_blank');
  const body = document.getElementById('att-admin-body');
  w.document.write(`<!DOCTYPE html><html><head>
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 12px; color: #000; }
      h1   { font-size: 16px; margin-bottom: 4px; }
      .sub { font-size: 11px; color: #666; margin-bottom: 14px; }
      table { border-collapse: collapse; width: 100%; font-size: 11px; }
      th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; white-space: nowrap; }
      th { background: #f5f5f5; font-weight: 700; }
      .att-cal-td-present  { background: #d1fae5; }
      .att-cal-td-late     { background: #fef3c7; }
      .att-cal-td-halfday  { background: #ddd6fe; }
      .att-cal-td-absent   { background: #fee2e2; }
      .att-cal-td-off      { background: #f0f0f0; color: #999; }
      .att-cal-td-pending  { background: #e0e7ff; }
      .att-cal-td-future   { background: #f9fafb; }
      .att-company-block  { margin-bottom: 24px; }
      .att-company-title  { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
      @media print { body { margin: 10mm; } }
    </style>
  </head><body>
    <h1>${title}</h1>
    <div class="sub">Vertex Electronics / Vision Engineering — Generated ${new Date().toLocaleDateString('en-GB')}</div>
    ${body ? body.innerHTML : ''}
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

// ── ATTENDANCE — Manage Users toggle (called from renderUsers) ─────────────────
async function attToggleUser(userId, currentVal) {
  const enabled = !currentVal;
  try {
    await api('PUT', `/attendance/toggle/${userId}`, { enabled });
    toast(enabled ? 'Attendance enabled' : 'Attendance disabled', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', checkAuth);
