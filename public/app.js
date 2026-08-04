'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const G = { me: null, token: null, view: 'login', detailId: null, compFilter: 'ALL' };

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
const TODAY = () => new Date().toISOString().slice(0, 10);

function fmt(d) {
  if (!d) return '—';
  return new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtLong(d) {
  return new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
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

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  return `<span class="code ${(t.company || '').toLowerCase()}">${esc(t.code)}</span>`;
}
function prPill(t) {
  const p = t.priority || 'low';
  return `<span class="pill p-${p}">${p[0].toUpperCase() + p.slice(1)}</span>`;
}
function stPill(t) {
  return `<span class="pill s-${t.status}">${ST_LABEL[t.status] || t.status}</span>`;
}
function duePill(t) {
  if (!t.due_date) return '<span class="due">No deadline</span>';
  const od = isOverdue(t);
  return `<span class="due${od ? ' over' : ''}">${od ? '⚠ ' : ''}${fmt(t.due_date)}</span>`;
}

// ── Task table ─────────────────────────────────────────────────────────────────
function taskTable(tasks, showWho) {
  if (!tasks.length) return '<div class="empty">No tasks found</div>';
  return `<div class="table-wrap"><table>
    <thead><tr>
      <th>Code</th><th>Task</th>
      ${showWho ? '<th>Assigned to</th>' : ''}
      <th>Priority</th><th>Status</th><th>Deadline</th><th>Progress</th>
    </tr></thead>
    <tbody>
    ${tasks.map(t => `<tr class="click" onclick="openTask(${t.id})">
      <td>${codeChip(t)}</td>
      <td class="task-title">${esc(t.title)}</td>
      ${showWho ? `<td><span style="font-weight:500">${esc(t.assignee_name || '—')}</span><br>
        <span class="small muted">${esc(t.assignee_dept || '')}</span></td>` : ''}
      <td>${prPill(t)}</td>
      <td>${stPill(t)}</td>
      <td>${duePill(t)}</td>
      <td><div class="progress"><i style="width:${taskPct(t)}%"></i></div></td>
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
    const { token, user } = await api('POST', '/auth/login', { email, password: pass });
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
  document.getElementById('app').style.display   = 'none';
  document.getElementById('login').style.display = 'flex';
}

async function checkAuth() {
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

function initApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display   = 'block';
  G.view = G.me.role === 'admin' ? 'dashboard' : 'myday';
  updateHeader();
  renderNav();
  renderView();
}

// ── Header ─────────────────────────────────────────────────────────────────────
function updateHeader() {
  document.getElementById('hdr-name').textContent = G.me.name;
  document.getElementById('hdr-role').textContent = G.me.role === 'admin'
    ? 'Admin · Vertex + Vision'
    : `${G.me.department || ''} · ${G.me.company === 'VTX' ? 'Vertex Electronics' : 'Vision Engineering'}`;
  document.getElementById('hdr-av').textContent = initials(G.me.name);
  document.getElementById('hdr-date').textContent = ' · ' +
    new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function renderNav() {
  const adminItems = [
    ['dashboard', 'Dashboard'], ['team', 'Team tasks'],
    ['assign', 'Assign task'], ['dailylogs', 'Daily logs'],
    ['users', 'Manage users'], ['myday', 'My day'],
    ['password', 'Change password'],
  ];
  const empItems = [
    ['myday', 'My day'], ['mytasks', 'My tasks'], ['history', 'My history'],
    ['password', 'Change password'],
  ];
  const items = G.me.role === 'admin' ? adminItems : empItems;
  const label = G.me.role === 'admin' ? 'Management' : 'Workspace';
  document.getElementById('nav').innerHTML =
    `<div class="navlabel">${label}</div>` +
    items.map(([v, l]) =>
      `<button class="${G.view === v ? 'active' : ''}" onclick="go('${v}')">${l}</button>`
    ).join('');
}

function go(v, params = {}) {
  G.view = v;
  G.detailId = null;
  Object.assign(G, params);
  renderNav();
  renderView();
}

function openTask(id) {
  G.detailId = id;
  G.view = 'detail';
  renderNav();
  renderView();
}

function openEditTask(id) {
  G.editTaskId = id;
  G.view = 'editTask';
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
    detail:    () => renderDetail(G.detailId),
    editTask:  () => renderEditTask(G.editTaskId),
    password:  renderChangePassword,
    dailylogs: renderDailyLogs,
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
    api('GET', `/logs?date=${today}`),
  ]);

  const pending = (myTasks || []).filter(t =>
    !['completed', 'cancelled'].includes(t.status) && t.assignee_id === G.me.id
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
            <select id="f-task">
              <option value="">No specific task (ad-hoc work)</option>
              ${opts}
            </select>
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
        ? pending.map(t => `
          <div class="task-mini" onclick="openTask(${t.id})">
            <div style="display:flex;gap:7px;align-items:center;margin-bottom:4px">
              ${codeChip(t)} ${prPill(t)}
            </div>
            <div class="task-mini-title">${esc(t.title)}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:5px">
              ${duePill(t)}
              <div class="progress" style="width:70px"><i style="width:${taskPct(t)}%"></i></div>
            </div>
          </div>`).join('')
        : '<div class="empty">No pending tasks assigned to you</div>'}
    </div>
  </div>`;
}

function logRow(l) {
  return `<div class="logentry">
    <div class="top">
      ${l.task_code
        ? `<span class="code ${(l.task_company || '').toLowerCase()}">${esc(l.task_code)}</span>`
        : '<span class="code">AD-HOC</span>'}
      <span style="font-size:13px;font-weight:500">${esc(l.task_title || 'Other work')}</span>
      ${l.status_after ? `<span class="pill s-${l.status_after}">→ ${ST_LABEL[l.status_after] || l.status_after}</span>` : ''}
      ${l.hours ? `<span class="muted small">${l.hours}h</span>` : ''}
    </div>
    <div style="font-size:13.5px;margin-bottom:2px">${esc(l.description)}</div>
    <div class="t">${fmtTime(l.logged_at)}</div>
  </div>`;
}

async function submitLog(e) {
  e.preventDefault();
  const task_id     = document.getElementById('f-task').value || null;
  const description = document.getElementById('f-txt').value.trim();
  const hours       = parseFloat(document.getElementById('f-hrs').value) || null;
  const status_after = document.getElementById('f-st').value || null;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', '/logs', { task_id: task_id ? +task_id : null, description, hours, status_after });
    toast('Entry added ✓', 'success');
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── MY TASKS ──────────────────────────────────────────────────────────────────
async function renderMyTasks() {
  const main  = document.getElementById('main');
  const tasks = await api('GET', '/tasks') || [];
  const od    = tasks.filter(isOverdue).length;
  const pending = tasks.filter(t => !['completed', 'cancelled'].includes(t.status)).length;

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>My tasks</h1>
    <div class="sub">${pending} pending · ${od} overdue</div></div>
  </div>
  ${taskTable(tasks, false)}`;
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
async function renderHistory() {
  const main = document.getElementById('main');
  const logs = await api('GET', '/logs') || [];

  const byDate = {};
  logs.forEach(l => {
    const d = l.log_date.slice(0, 10);
    (byDate[d] = byDate[d] || []).push(l);
  });
  const dates = Object.keys(byDate).sort().reverse();

  main.innerHTML = `
  <div class="pagehead"><div><h1>My history</h1><div class="sub">Past daily logs</div></div></div>
  ${dates.map(d => `
    <div class="card" style="margin-bottom:14px">
      <h2 style="margin-bottom:10px">${fmtLong(d)}</h2>
      ${byDate[d].map(logRow).join('')}
    </div>`).join('') || '<div class="empty">No history yet — start logging your work today.</div>'}`;
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
    <div class="kpi ok">
      <div class="n">${es.logged_today || 0}/${es.total_employees || 0}</div>
      <div class="l">Logged work today</div>
    </div>
    <div class="kpi ${+ts.overdue > 0 ? 'warn' : ''}">
      <div class="n">${ts.overdue || 0}</div>
      <div class="l">Overdue tasks</div>
    </div>
    <div class="kpi ${+ts.blocked > 0 ? 'warn' : ''}">
      <div class="n">${ts.blocked || 0}</div>
      <div class="l">Blocked</div>
    </div>
    <div class="kpi">
      <div class="n">${ts.due_this_week || 0}</div>
      <div class="l">Due this week</div>
    </div>
  </div>

  <div class="grid2" style="grid-template-columns:270px 1fr">
    <div>
      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:10px">Not yet logged today</h2>
        ${notLogged.map(u => `
          <div class="name-dot" style="padding:7px 0;border-bottom:1px solid var(--line)">
            <span class="dot" style="background:${u.company === 'VTX' ? 'var(--amber)' : 'var(--blue)'}"></span>
            <div>
              <div style="font-size:13.5px;font-weight:500">${esc(u.name)}</div>
              <div class="small muted">${esc(u.department || '')} · ${u.company === 'VTX' ? 'Vertex' : 'Vision'}</div>
            </div>
          </div>`).join('') || '<div class="empty">Everyone has logged ✓</div>'}
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px">Who logged today</h2>
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
        <h2 style="margin-bottom:10px">⚠ Overdue tasks</h2>
        ${overdueT.length ? taskTable(overdueT, true) : '<div class="empty">No overdue tasks</div>'}
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px">Blocked tasks</h2>
        ${blockedT.length ? taskTable(blockedT, true) : '<div class="empty">Nothing blocked</div>'}
      </div>
    </div>
  </div>`;
}

// ── TEAM TASKS (admin) ────────────────────────────────────────────────────────
async function renderTeam() {
  const main  = document.getElementById('main');
  const cf    = G.compFilter;
  const tasks = await api('GET', `/tasks${cf !== 'ALL' ? `?company=${cf}` : ''}`) || [];
  const active = tasks.filter(t => !['completed', 'cancelled'].includes(t.status)).length;

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Team tasks</h1>
    <div class="sub">${tasks.length} total · ${active} active</div></div>
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
  ${taskTable(tasks, true)}`;
}

// ── ASSIGN TASK (admin) ───────────────────────────────────────────────────────
async function renderAssign() {
  const main  = document.getElementById('main');
  const users = await api('GET', '/users') || [];
  const emps  = users.filter(u => u.role === 'employee' && u.active);

  window._assignEmps = { VTX: emps.filter(u => u.company === 'VTX'), VSN: emps.filter(u => u.company === 'VSN') };
  const empOpts = (list) => list.map(u =>
    `<option value="${u.id}">${esc(u.name)} — ${esc(u.department || '')}</option>`).join('');

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  main.innerHTML = `
  <div class="pagehead">
    <div><h1>Assign task</h1><div class="sub">Create and assign a task to an employee</div></div>
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
    toast(`${task.code} assigned to ${task.assignee_name}`, 'success');
    go('team');
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
    <button class="btn btn-amber" onclick="showUserForm()">+ Add user</button>
  </div>
  <div id="user-form-panel"></div>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Name</th><th>Email</th><th>Company</th><th>Department</th><th>Role</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>
    ${users.map(u => `<tr>
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
      <td><button class="btn btn-ghost btn-sm" onclick="showUserForm(${u.id})">Edit</button></td>
    </tr>`).join('')}
    </tbody></table></div>`;
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
            <option value="VTX" ${!user || user.company === 'VTX' ? 'selected' : ''}>Vertex Electronics</option>
            <option value="VSN" ${user?.company === 'VSN' ? 'selected' : ''}>Vision Engineering</option>
            <option value="ALL" ${user?.company === 'ALL' ? 'selected' : ''}>Both (ALL)</option>
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
  const main = document.getElementById('main');
  const [task, logs, comments] = await Promise.all([
    api('GET', `/tasks/${id}`),
    api('GET', `/logs?task_id=${id}`),
    api('GET', `/comments?task_id=${id}`),
  ]);

  if (!task) { main.innerHTML = '<div class="error-msg">Task not found</div>'; return; }

  const pct      = taskPct(task);
  const backView = G.me.role === 'admin' ? 'team' : 'mytasks';
  const isAdmin  = G.me.role === 'admin';
  const canAct   = isAdmin || task.assignee_id === G.me.id;

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
                    <b style="font-size:13px">${esc(item.user_name || '')}</b>
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
        <div style="display:flex;gap:8px;margin-top:12px">
          <input id="c-txt" placeholder="Write a comment…" style="flex:1">
          <button class="btn btn-sm" onclick="submitComment(${task.id})">Post</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2>Objectives</h2>
        <span style="font-family:var(--mono);font-size:14px;font-weight:600;color:${pct === 100 ? 'var(--green)' : 'var(--ink)'}">${pct}%</span>
      </div>
      <div class="progress" style="margin-bottom:14px">
        <i style="width:${pct}%;background:${pct === 100 ? 'var(--green)' : 'var(--amber)'}"></i>
      </div>
      ${(task.objectives || []).length
        ? task.objectives.map(o => `
          <label class="obj${o.done ? ' done' : ''}">
            <input type="checkbox" ${o.done ? 'checked' : ''} ${canAct ? '' : 'disabled'}
              onchange="toggleObj(${task.id}, ${o.id}, this.checked)">
            <span>${esc(o.text)}</span>
          </label>`).join('')
        : '<div class="empty">No objectives defined</div>'}

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        <div class="small muted" style="margin-bottom:6px">
          Created ${fmt(task.created_at)} · Updated ${fmt(task.updated_at)}
        </div>
      </div>
    </div>
  </div>`;
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

async function submitComment(taskId) {
  const el  = document.getElementById('c-txt');
  const btn = el.nextElementSibling;
  if (!el?.value.trim()) return;
  btn.disabled = true;
  try {
    await api('POST', '/comments', { task_id: taskId, text: el.value.trim() });
    el.value = '';
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
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
              : '<span class="code">AD-HOC</span><span style="font-size:13px;font-weight:500">Other work</span>'}
            ${l.status_after ? `<span class="pill s-${l.status_after}">→ ${ST_LABEL[l.status_after] || l.status_after}</span>` : ''}
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
            <div class="small muted">${esc(u.department || '')} · ${u.company === 'VTX' ? 'Vertex' : 'Vision'}</div>
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
function commentHtml(c, replyMap, taskId) {
  const replies = (replyMap[c.id] || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return `
    <div class="comment">
      <b>${esc(c.user_name || '')}</b>
      <span class="t">${fmtDateTime(c.created_at)}</span>
      <div style="margin-top:4px">${esc(c.text)}</div>
      <button onclick="showReplyBox(${c.id},${taskId})"
        style="background:none;border:none;color:var(--amber);font-size:11px;cursor:pointer;padding:3px 0;font-weight:600">
        ↩ Reply
      </button>
      <div id="reply-box-${c.id}"></div>
      ${replies.map(r => `
        <div class="comment" style="margin-left:20px;margin-top:6px;padding-left:12px;border-left:2px solid var(--line)">
          <b>${esc(r.user_name || '')}</b>
          <span class="t">${fmtDateTime(r.created_at)}</span>
          <div style="margin-top:4px">${esc(r.text)}</div>
        </div>`).join('')}
    </div>`;
}

function showReplyBox(commentId, taskId) {
  const box = document.getElementById(`reply-box-${commentId}`);
  if (!box) return;
  if (box.innerHTML.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div style="display:flex;gap:8px;margin-top:8px;margin-left:20px">
      <input id="ri-${commentId}" placeholder="Write a reply…"
        style="flex:1;padding:6px 10px;border:1px solid var(--line);border-radius:6px;font-size:13px;background:var(--surface);color:var(--ink)">
      <button class="btn btn-sm" onclick="submitReply(${taskId},${commentId},'ri-${commentId}')">Post</button>
      <button class="btn btn-ghost btn-sm" onclick="document.getElementById('reply-box-${commentId}').innerHTML=''">Cancel</button>
    </div>`;
  document.getElementById(`ri-${commentId}`)?.focus();
}

async function submitReply(taskId, parentId, inputId) {
  const el = document.getElementById(inputId);
  if (!el?.value.trim()) return;
  const btn = el.nextElementSibling;
  btn.disabled = true;
  try {
    await api('POST', '/comments', { task_id: taskId, text: el.value.trim(), parent_id: parentId });
    renderView();
  } catch (ex) {
    toast(ex.message, 'error');
    btn.disabled = false;
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', checkAuth);
