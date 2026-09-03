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

// Where a user lands after login — concierges start on their work queue (IA4),
// everyone else on the main dashboard.
function landingPath(user) {
  return (user && user.role === 'Client Concierge') ? '/call-center/my-queue/' : '/dashboard/';
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
  { href: '/members/',   icon: 'fa-user-injured',      label: 'Members',     key: 'members' },
  { href: '/tasks/',     icon: 'fa-list-check',        label: 'Tasks',       key: 'tasks' },
  { href: '/reminders/',icon: 'fa-bell',              label: 'Reminders',   key: 'reminders' },
  { section: 'Sales' },
  { href: '/sales/',     icon: 'fa-chart-line',        label: 'Sales Dashboard', key: 'sales-dashboard' },
  { href: '/leads/',     icon: 'fa-user-plus',         label: 'Leads',       key: 'leads' },
  { section: 'Marketing' },
  { href: '/marketing/schedulers/',   icon: 'fa-calendar-check', label: 'Schedulers',   key: 'marketing-schedulers' },
  { href: '/marketing/appointments/', icon: 'fa-calendar-day',   label: 'Appointments', key: 'marketing-appointments' },
  { href: '/marketing/email-templates/', icon: 'fa-envelope-open-text', label: 'Email Templates', key: 'marketing-email-templates' },
  { href: '/marketing/campaigns/',    icon: 'fa-paper-plane',    label: 'Email Campaigns', key: 'marketing-campaigns' },
  { section: 'Pharmacy' },
  { href: '/batch/',     icon: 'fa-pills',             label: 'Batch Orders',key: 'batch' },
  { href: '/temp-batch/',icon: 'fa-inbox',             label: 'Temp Batch',  key: 'temp-batch' },
  { section: 'AMT & Assignment' },
  { href: '/glp1/ready-to-assign/', icon: 'fa-user-clock', label: 'Ready to Assign', key: 'glp1-ready' },
  { href: '/glp1/assigned/',        icon: 'fa-user-check', label: 'Assigned',        key: 'glp1-assigned' },
  { section: 'Call Center' },
  { href: '/call-center/my-queue/',    icon: 'fa-list-check',     label: 'My Queue',       key: 'cc-my-queue' },
  { href: '/call-center/in-progress/', icon: 'fa-hourglass-half', label: 'In Progress',    key: 'cc-in-progress' },
  { href: '/call-center/other/',       icon: 'fa-list-check',     label: 'Other Statuses', key: 'cc-other' },
  { section: 'Invoices & Statements' },
  { href: '/invoices/list/',      icon: 'fa-file-invoice-dollar', label: 'Invoices', key: 'invoices-list' },
  { href: '/invoices/dashboard/', icon: 'fa-chart-pie', label: 'Dashboard', key: 'invoices-dashboard' },
  { href: '/invoices/data/',      icon: 'fa-table',     label: 'Invoice Data', key: 'invoices-data' },
  { href: '/invoices/transactions/', icon: 'fa-receipt', label: 'Transactions', key: 'invoices-transactions' },
  { href: '/invoices/master-report/', icon: 'fa-file-lines', label: 'Master Order Report', key: 'invoices-master-report' },
  { section: 'Eligibility & Claims Imports' },
  { href: '/imports/', icon: 'fa-file-import', label: 'Imports', key: 'imports' },
  { href: '/imports/liviniti/', icon: 'fa-file-medical', label: 'Liviniti Feed', key: 'liviniti' },
  { section: 'PBM Tracking' },
  { href: '/pbms/', icon: 'fa-building-shield', label: 'PBM', key: 'pbms' },
  { href: '/pbms/intake/', icon: 'fa-inbox', label: 'Member Submissions', key: 'pbm-intake' },
  { section: 'Procurement' },
  { href: '/procurement/products/', icon: 'fa-prescription-bottle-medical', label: 'Product Master', key: 'procurement-products' },
  { href: '/procurement/vendors/', icon: 'fa-truck-field', label: 'Vendors', key: 'procurement-vendors' },
  { href: '/procurement/pricing/', icon: 'fa-tags', label: 'Client Pricing', key: 'procurement-pricing' },
  { section: 'Project Management' },
  { href: '/project-management/', icon: 'fa-gauge-high',    label: 'Dashboard',    key: 'pm-dashboard' },
  { href: 'https://claude.ai/code/artifact/751d6e4f-d8e4-47a4-ab83-44d367d28fd9', icon: 'fa-map', label: 'Roadmap', key: 'pm-roadmap', external: true },
  { href: '/project-plan/', icon: 'fa-diagram-project',    label: 'Project Plan', key: 'project-plan' },
  { href: '/project-management/bugs/', icon: 'fa-bug',      label: 'Bugs/Changes', key: 'pm-bugs' },
  { section: 'Admin' },
  { href: '/brokers/',   icon: 'fa-handshake',         label: 'Brokers',     key: 'brokers' },
  { href: '/admin/intake-types/', icon: 'fa-diagram-next', label: 'Intake Types', key: 'intake-types' },
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
    const ext = item.external ? ' target="_blank" rel="noopener"' : '';
    return `<a class="nav-link${item.key === activeKey ? ' active' : ''}" href="${item.href}"${ext}>
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
    dashboard: 'Dashboard', clients: 'Clients', 'client-record': 'Client Record', members: 'Members',
    'sales-dashboard': 'Sales Dashboard', leads: 'Leads', tasks: 'Tasks',
    reminders: 'Reminders', 'marketing-schedulers': 'Marketing — Schedulers',
    'marketing-appointments': 'Marketing — Appointments',
    'marketing-email-templates': 'Marketing — Email Templates',
    'marketing-campaigns': 'Marketing — Email Campaigns',
    batch: 'Batch Orders', 'temp-batch': 'Temp Batch',
    'glp1-ready': 'AMT & Assignment — Ready to Assign', 'glp1-assigned': 'AMT & Assignment — Assigned',
    'glp1-report': 'AMT & Assignment — Ready to Assign Report', 'glp1-record': 'Member Record',
    'cc-my-queue': 'Call Center — My Queue',
    'cc-in-progress': 'Call Center — In Progress', 'cc-other': 'Call Center — Other Statuses',
    'invoices-list': 'Invoices',
    'invoices-dashboard': 'Invoices & Statements — Dashboard',
    'invoices-data': 'Invoices & Statements — Invoice Data',
    'invoices-transactions': 'Invoices & Statements — Transactions',
    'invoices-master-report': 'Invoices & Statements — Master Order Report',
    imports: 'Eligibility & Claims Imports',
    liviniti: 'Liviniti Feed — RxCompass Eligibility',
    pbms: 'PBM Tracking', 'pbm-record': 'PBM Record', 'pbm-intake': 'PBM Tracking — Member Submissions',
    'procurement-products': 'Procurement — Product Master', 'procurement-vendors': 'Procurement — Vendors',
    'procurement-pricing': 'Procurement — Client Pricing & Formulary',
    companies: 'Companies', brokers: 'Brokers', 'user-management': 'User Management',
    'intake-types': 'Intake Types',
    'pm-dashboard': 'Project Management — Dashboard', 'pm-bugs': 'Project Management — Bugs / Changes',
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

/* ── Feedback widget: point-and-pin annotations (multiple per screen) ── */
const H2C_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.html2canvas) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
let __fbBase = null;   // captured page screenshot (canvas)
let __fbPins = [];     // [{id, x, y, fx, fy, note}]
let __fbSeq = 0;
function fbEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function initFeedback() {
  if (document.getElementById('feedback-fab')) return;
  const fab = document.createElement('button');
  fab.id = 'feedback-fab'; fab.className = 'feedback-fab'; fab.title = 'Pin feedback on this screen';
  fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i> Feedback';
  fab.onclick = startPinFeedback;
  document.body.appendChild(fab);
}

// Capture the page once, then drop as many pins as needed and annotate each.
async function startPinFeedback() {
  if (document.getElementById('fb-overlay')) return;   // already in pin mode
  const fab = document.getElementById('feedback-fab');
  fab.disabled = true; fab.style.opacity = '.6'; fab.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Capturing…';
  try {
    await loadScript(H2C_SRC);
    __fbBase = await html2canvas(document.body, { logging: false, useCORS: true, scale: 0.7 });
  } catch (e) { __fbBase = null; }
  fab.disabled = false; fab.style.opacity = ''; fab.innerHTML = '<i class="fa-solid fa-comment-dots"></i> Feedback';
  __fbPins = []; __fbSeq = 0;
  buildPinMode();
}

function fbDocSize() {
  return {
    w: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
    h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
  };
}

function buildPinMode() {
  const { w, h } = fbDocSize();
  const overlay = document.createElement('div');
  overlay.id = 'fb-overlay';
  overlay.style.width = w + 'px'; overlay.style.height = h + 'px';
  overlay.addEventListener('click', onPinClick);
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.id = 'fb-panel';
  panel.innerHTML = `
    <div class="fb-head"><b>Pin feedback</b>
      <button class="fb-x" onclick="cancelPinFeedback()" title="Cancel">&times;</button></div>
    <div class="fb-hint"><i class="fa-solid fa-location-dot"></i> Click anywhere on the page to drop a pin, then say what should change. Add as many as you like.</div>
    <div id="fb-pin-list" class="fb-pin-list"></div>
    <div class="fb-actions">
      <span class="fb-note"><i class="fa-solid fa-paperclip"></i> Screenshot attached</span>
      <button id="fb-submit" class="btn btn-primary btn-sm" onclick="submitPins()" disabled>Submit</button>
    </div>`;
  document.body.appendChild(panel);
  document.getElementById('feedback-fab').style.display = 'none';
  renderPinList();
}

function onPinClick(e) {
  const x = e.pageX, y = e.pageY, { w, h } = fbDocSize();
  const id = ++__fbSeq;
  __fbPins.push({ id, x, y, fx: x / w, fy: y / h, note: '' });
  const m = document.createElement('div');
  m.className = 'fb-pin'; m.id = 'fb-pin-' + id;
  m.style.left = x + 'px'; m.style.top = y + 'px';
  document.getElementById('fb-overlay').appendChild(m);
  renderPinList();
  const ta = document.querySelector('#fb-pin-row-' + id + ' textarea'); if (ta) ta.focus();
}

function renderPinList() {
  const list = document.getElementById('fb-pin-list');
  if (!list) return;
  list.innerHTML = __fbPins.length ? __fbPins.map((p, i) => `
    <div class="fb-pin-row" id="fb-pin-row-${p.id}">
      <span class="fb-pin-badge">${i + 1}</span>
      <textarea class="form-control" rows="2" placeholder="What should change here?"
        oninput="setPinNote(${p.id}, this.value)">${fbEsc(p.note)}</textarea>
      <button class="fb-pin-rm" onclick="removePin(${p.id})" title="Remove pin">&times;</button>
    </div>`).join('') : '<div class="fb-empty">No pins yet — click the page to add one.</div>';
  __fbPins.forEach((p, i) => { const m = document.getElementById('fb-pin-' + p.id); if (m) m.textContent = i + 1; });
  updateSubmit();
}
function setPinNote(id, v) { const p = __fbPins.find(x => x.id === id); if (p) p.note = v; updateSubmit(); }
function removePin(id) {
  __fbPins = __fbPins.filter(x => x.id !== id);
  const m = document.getElementById('fb-pin-' + id); if (m) m.remove();
  renderPinList();
}
function updateSubmit() {
  const b = document.getElementById('fb-submit'); if (!b) return;
  const n = __fbPins.filter(p => p.note.trim()).length;
  b.disabled = n === 0; b.textContent = n ? `Submit ${n}` : 'Submit';
}

// Draw one pin marker onto a copy of the base screenshot so each feedback item
// points at exactly its own spot.
function annotatedShot(pin, num) {
  if (!__fbBase) return null;
  const c = document.createElement('canvas'); c.width = __fbBase.width; c.height = __fbBase.height;
  const ctx = c.getContext('2d'); ctx.drawImage(__fbBase, 0, 0);
  const x = pin.fx * c.width, y = pin.fy * c.height, r = Math.max(14, c.width * 0.014);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#e11d48'; ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.18); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(r * 1.15)}px Arial`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(num), x, y + 1);
  return c.toDataURL('image/jpeg', 0.72);
}

function submitPins() {
  const pins = __fbPins.filter(p => p.note.trim());
  if (!pins.length) return;
  const btn = document.getElementById('fb-submit'); btn.disabled = true; btn.textContent = 'Sending…';
  let sent = 0;
  const jobs = pins.map((p, i) => apiPost('/project-plan?resource=feedback', {
    text: p.note.trim(),
    page_url: location.href.split('#')[0] + `#pin=${Math.round(p.fx * 100)},${Math.round(p.fy * 100)}`,
    screenshot: annotatedShot(p, i + 1),
  }).then(r => { if (r && r.ok) sent++; }).catch(() => {}));
  Promise.all(jobs).then(() => {
    showToast(sent === pins.length ? `Sent ${sent} feedback pin${sent === 1 ? '' : 's'} — thank you!`
      : `Sent ${sent} of ${pins.length} — some failed`, sent ? 'success' : 'error');
    cancelPinFeedback();
  });
}

function cancelPinFeedback() {
  ['fb-overlay', 'fb-panel'].forEach(id => { const e = document.getElementById(id); if (e) e.remove(); });
  __fbPins = []; __fbBase = null;
  const fab = document.getElementById('feedback-fab'); if (fab) fab.style.display = '';
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
