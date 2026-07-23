/* ── Auth ── */
const API = '/.netlify/functions';
const TOKEN_KEY = 'tp_token';
const USER_KEY  = 'tp_user';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getUser()  { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } }
function setAuth(token, user) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(USER_KEY, JSON.stringify(user)); }
function clearAuth() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

function requireAuth() {
  if (!getToken()) { window.location.href = '/login.html'; }
}

function logout() {
  clearAuth();
  window.location.href = '/login.html';
}

/* ── API ── */
async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { clearAuth(); window.location.href = '/login.html'; return null; }
  return res;
}

async function apiGet(path) {
  const res = await apiFetch(path);
  if (!res || !res.ok) return null;
  return res.json();
}

async function apiPost(path, body) {
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
  return res;
}

async function apiPatch(path, body) {
  const res = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  return res;
}

async function apiDelete(path) {
  const res = await apiFetch(path, { method: 'DELETE' });
  return res;
}

/* ── Utilities ── */
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d : `${dt.getMonth()+1}/${dt.getDate()}/${dt.getFullYear()}`;
}

function fmtCurrency(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function confirm2(msg) { return window.confirm(msg); }

/* ── Nav ── */
const NAV_ITEMS = [
  { section: 'Main' },
  { href: '/dashboard/', icon: 'fa-gauge-high',       label: 'Dashboard',   key: 'dashboard' },
  { href: '/clients/',   icon: 'fa-users',             label: 'Clients',     key: 'clients' },
  { href: '/leads/',     icon: 'fa-user-plus',         label: 'Leads',       key: 'leads' },
  { href: '/tasks/',     icon: 'fa-list-check',        label: 'Tasks',       key: 'tasks' },
  { href: '/reminders/',icon: 'fa-bell',              label: 'Reminders',   key: 'reminders' },
  { section: 'Marketing' },
  { href: '/marketing/schedulers/',   icon: 'fa-calendar-check', label: 'Schedulers',   key: 'marketing-schedulers' },
  { href: '/marketing/appointments/', icon: 'fa-calendar-day',   label: 'Appointments', key: 'marketing-appointments' },
  { section: 'Pharmacy' },
  { href: '/batch/',     icon: 'fa-pills',             label: 'Batch Orders',key: 'batch' },
  { href: '/temp-batch/',icon: 'fa-inbox',             label: 'Temp Batch',  key: 'temp-batch' },
  { section: 'GLP1' },
  { href: '/glp1/ready-to-assign/', icon: 'fa-user-clock', label: 'Ready to Assign', key: 'glp1-ready' },
  { href: '/glp1/assigned/',        icon: 'fa-user-check', label: 'Assigned',        key: 'glp1-assigned' },
  { section: 'Call Center' },
  { href: '/call-center/in-progress/', icon: 'fa-hourglass-half', label: 'In Progress',    key: 'cc-in-progress' },
  { href: '/call-center/other/',       icon: 'fa-list-check',     label: 'Other Statuses', key: 'cc-other' },
  { section: 'Invoices & Statements' },
  { href: '/invoices/list/',      icon: 'fa-file-invoice-dollar', label: 'Invoices', key: 'invoices-list' },
  { href: '/invoices/dashboard/', icon: 'fa-chart-pie', label: 'Dashboard', key: 'invoices-dashboard' },
  { href: '/invoices/data/',      icon: 'fa-table',     label: 'Invoice Data', key: 'invoices-data' },
  { section: 'Eligibility & Claims Imports' },
  { href: '/imports/', icon: 'fa-file-import', label: 'Imports', key: 'imports' },
  { section: 'Admin' },
  { href: '/brokers/',   icon: 'fa-handshake',         label: 'Brokers',     key: 'brokers' },
  { section: 'Settings', adminOnly: true },
  { href: '/settings/user-management/', icon: 'fa-users-gear', label: 'User Management', key: 'user-management' },
];

// True when the logged-in user may see a given nav section.
// Admins (user_type 'Admin' / is_admin) see everything. Others are limited to
// the sections listed in their nav_access (CSV). 'Settings' is always admin-only.
function canSeeSection(section, user) {
  const admin = !!user && (user.user_type === 'Admin' || user.is_admin === true);
  if (admin) return true;
  if (section === 'Settings') return false;
  const allowed = (user && user.nav_access ? user.nav_access : '').split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(section);
}

function initNav(activeKey) {
  requireAuth();
  const user = getUser();

  // Build sidebar, hiding sections the user has no access to (and their items).
  let visibleSection = true;
  const items = NAV_ITEMS.map(item => {
    if (item.section) {
      visibleSection = canSeeSection(item.section, user);
      return visibleSection ? `<div class="nav-section">${item.section}</div>` : '';
    }
    if (!visibleSection) return '';
    return `<a class="nav-link${item.key === activeKey ? ' active' : ''}" href="${item.href}">
      <i class="fa-solid ${item.icon}"></i>
      <span class="nav-label">${item.label}</span>
    </a>`;
  }).join('');

  document.getElementById('nav-placeholder').innerHTML = `
    <div id="sidebar">
      <div class="brand">
        <a href="https://truepathsourcing.com/" target="_blank" rel="noopener" title="True Path Sourcing">
          <img src="/assets/img/truepath-logo.png" alt="True Path Sourcing" class="brand-logo">
        </a>
      </div>
      ${items}
      <div style="margin-top:auto; padding:16px;">
        <a class="nav-link" onclick="logout()" style="cursor:pointer;">
          <i class="fa-solid fa-right-from-bracket"></i>
          <span class="nav-label">Logout</span>
        </a>
      </div>
    </div>`;

  // Build topbar
  const pageTitles = {
    dashboard: 'Dashboard', clients: 'Clients', 'client-record': 'Client Record', leads: 'Leads', tasks: 'Tasks',
    reminders: 'Reminders', 'marketing-schedulers': 'Marketing — Schedulers',
    'marketing-appointments': 'Marketing — Appointments',
    batch: 'Batch Orders', 'temp-batch': 'Temp Batch',
    'glp1-ready': 'GLP1 — Ready to Assign', 'glp1-assigned': 'GLP1 — Assigned',
    'glp1-report': 'GLP1 — Ready to Assign Report', 'glp1-record': 'Member Record',
    'cc-in-progress': 'Call Center — In Progress', 'cc-other': 'Call Center — Other Statuses',
    'invoices-list': 'Invoices',
    'invoices-dashboard': 'Invoices & Statements — Dashboard',
    'invoices-data': 'Invoices & Statements — Invoice Data',
    imports: 'Eligibility & Claims Imports',
    companies: 'Companies', brokers: 'Brokers', 'user-management': 'User Management',
    'project-plan': 'Project Plan', 'release-notes': 'Release Notes',
  };
  const userName = (user && (user.firstname + ' ' + user.lastname).trim()) || user?.email || '';
  document.getElementById('topbar').innerHTML = `
    <span class="topbar-title">${pageTitles[activeKey] || ''}</span>
    <div class="topbar-usermenu">
      <button class="topbar-user" onclick="toggleUserMenu(event)" aria-haspopup="true">
        <i class="fa-solid fa-user-circle"></i><span>${esc(userName)}</span>
        <i class="fa-solid fa-chevron-down chev"></i>
      </button>
      <div class="user-menu hidden" id="user-menu">
        <a href="/project-plan/"><i class="fa-solid fa-diagram-project"></i> Project Plan</a>
        <a href="/release-notes/"><i class="fa-solid fa-rocket"></i> Release Notes</a>
        <div class="user-menu-sep"></div>
        <a onclick="logout()" style="cursor:pointer"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
      </div>
    </div>`;

  // Toast container
  if (!document.getElementById('toast-container')) {
    const tc = document.createElement('div');
    tc.id = 'toast-container';
    document.body.appendChild(tc);
  }
  initFeedback();
}

/* ── User menu dropdown ── */
function toggleUserMenu(e) {
  e.stopPropagation();
  const m = document.getElementById('user-menu');
  if (m) m.classList.toggle('hidden');
}
document.addEventListener('click', () => {
  const m = document.getElementById('user-menu');
  if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
});

/* ── Feedback widget (floating, every page) ── */
const H2C_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.html2canvas) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function initFeedback() {
  if (document.getElementById('feedback-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'feedback-fab'; fab.className = 'feedback-fab'; fab.title = 'Send feedback';
  fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i> Feedback';
  fab.onclick = openFeedback;
  document.body.appendChild(fab);

  const modal = document.createElement('div');
  modal.id = 'feedback-modal'; modal.className = 'feedback-modal hidden';
  modal.innerHTML = `
    <div class="fb-head"><b>Send feedback</b>
      <button class="fb-x" onclick="closeFeedback()" title="Close">&times;</button></div>
    <div class="fb-shot"><img id="fb-preview" alt="Page screenshot"><span id="fb-capturing">Capturing screen…</span></div>
    <textarea id="fb-text" class="form-control" rows="4"
      placeholder="What should change or improve on this page?"></textarea>
    <div class="fb-actions">
      <span class="fb-note"><i class="fa-solid fa-paperclip"></i> Screenshot of this page attached</span>
      <button class="btn btn-primary btn-sm" onclick="submitFeedback()">Send</button>
    </div>`;
  document.body.appendChild(modal);
}
async function openFeedback() {
  const fab = document.getElementById('feedback-fab');
  const modal = document.getElementById('feedback-modal');
  const preview = document.getElementById('fb-preview');
  const capturing = document.getElementById('fb-capturing');
  document.getElementById('fb-text').value = '';
  preview.style.display = 'none'; capturing.style.display = ''; window.__fbShot = null;
  modal.classList.remove('hidden');
  try {
    await loadScript(H2C_SRC);
    fab.style.visibility = 'hidden'; modal.style.visibility = 'hidden';
    const canvas = await html2canvas(document.body, { logging: false, useCORS: true, scale: 0.7 });
    modal.style.visibility = ''; fab.style.visibility = '';
    window.__fbShot = canvas.toDataURL('image/jpeg', 0.72);
    preview.src = window.__fbShot; preview.style.display = '';
  } catch (e) {
    modal.style.visibility = ''; fab.style.visibility = '';
  }
  capturing.style.display = 'none';
}
function closeFeedback() { document.getElementById('feedback-modal').classList.add('hidden'); }
async function submitFeedback() {
  const text = document.getElementById('fb-text').value.trim();
  if (!text) { showToast('Please enter your feedback first', 'error'); return; }
  const res = await apiPost('/project-plan?resource=feedback',
    { text, page_url: location.href, screenshot: window.__fbShot || null });
  if (res && res.ok) { showToast('Feedback sent — thank you!', 'success'); closeFeedback(); }
  else { showToast('Could not send feedback', 'error'); }
}

/* ── Modal helpers ── */
function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

/* ── Status badge helpers ── */
const LEAD_STATUS_COLORS = { New:'blue', Contacted:'purple', Qualified:'green', Lost:'red', Converted:'gray' };
const TASK_STATUS_COLORS = { 'Not Started':'gray', 'In Progress':'blue', 'Testing':'yellow', Awaiting:'orange', Completed:'green' };
const TASK_PRIORITY_COLORS = { Low:'green', Medium:'yellow', High:'red', Urgent:'red' };
const BATCH_STATUS_COLORS  = { Pending:'yellow', Processing:'blue', Completed:'green', Error:'red', Rejected:'red' };

function statusBadge(status, map) {
  const color = map[status] || 'gray';
  return `<span class="badge badge-${color}">${esc(status)}</span>`;
}
