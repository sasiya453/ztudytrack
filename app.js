/* ================= A/L Study Tracker — app.js ================= */
const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
};
const DAY_MS = 86_400_000, SLT_OFFSET = 5.5 * 3_600_000;
const DAY_LIST = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const STREAM_SUBJECTS = {
  Maths: ['Combined Maths', 'Physics', 'Chemistry'],
  Bio:   ['Bio', 'Physics', 'Chemistry'],
};
const STATUS_CYCLE = [
  { status: 'not done',   attempt: 0, label: '' },
  { status: '1st time',   attempt: 1, label: '1st' },
  { status: '2nd time+',  attempt: 2, label: '2nd+' },
];
const STATUS_CLASS = { 'not done': 'st-not-done', '1st time': 'st-first', '2nd time+': 'st-second' };

let db = null, me = null, settings = null, activeSubject = null, chart = null;
const $ = id => document.getElementById(id);
const sltDate = (d = new Date()) => new Date(d.getTime() + SLT_OFFSET).toISOString().slice(0, 10);

/* ---------------- Boot & auth ---------------- */
window.addEventListener('DOMContentLoaded', boot);

function boot() {
  const hash = new URLSearchParams(location.hash.slice(1)).get('auth');
  const token = hash || localStorage.getItem('alt_token');
  history.replaceState(null, '', location.pathname); // strip token from URL
  if (!token) return; // login view stays visible

  localStorage.setItem('alt_token', token);
  db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  loadApp().catch(err => { console.error(err); logout(); });
}

async function loadApp() {
  const token = localStorage.getItem('alt_token');
  const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const { data, error } = await db.from('users').select('*').eq('telegram_id', payload.telegram_id).single();
  if (error) throw error;
  me = data;

  // settings (create default row on first visit)
  let { data: s } = await db.from('user_settings').select('*').eq('user_id', me.telegram_id).maybeSingle();
  if (!s) {
    ({ data: s } = await db.from('user_settings')
      .upsert({ user_id: me.telegram_id, stream: 'Maths' }, { onConflict: 'user_id' })
      .select().single());
  }
  settings = s;

  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('user-name').textContent = me.name.split(' ')[0];
  if (me.photo_url) $('user-avatar').src = me.photo_url;

  buildSubjectTabs();
  fillSettingsModal();
  bindUI();
  await Promise.all([loadStats(), loadLeaderboard(), renderPaperGrid()]);
}

function logout() { localStorage.removeItem('alt_token'); location.reload(); }

/* ---------------- Stats + growth chart ---------------- */
async function loadStats() {
  const from = sltDate(new Date(Date.now() - 13 * DAY_MS));
  const [{ data: sessions }, { count: papersDone }] = await Promise.all([
    db.from('study_sessions').select('session_date, study_hours')
      .eq('subject', 'Total').gte('session_date', from).order('session_date'),
    db.from('past_papers').select('id', { count: 'exact', head: true })
      .neq('status', 'not done'),
  ]);

  const byDate = new Map(sessions.map(r => [r.session_date, +r.study_hours]));
  const labels = [], values = [], cumulative = [];
  for (let i = 13, run = 0; i >= 0; i--) {
    const d = sltDate(new Date(Date.now() - i * DAY_MS));
    const h = byDate.get(d) || 0;
    labels.push(d.slice(5)); values.push(h); run += h; cumulative.push(+run.toFixed(1));
  }

  $('stat-today').innerHTML  = `${values[13]}<span class="unit">h</span>`;
  $('stat-week').innerHTML   = `${values.slice(7).reduce((a, b) => a + b, 0)}<span class="unit">h</span>`;
  $('stat-papers').textContent = papersDone ?? 0;

  // streak: consecutive days (ending today or yesterday) with hours > 0
  let streak = 0, i = 13;
  if (values[13] === 0 && values[12] === 0) i = 12;              // today not yet logged → count up to yesterday
  for (; i >= 0 && values[i] > 0; i--) streak++;
  $('stat-streak').innerHTML = `${streak}<span class="unit">🔥</span>`;

  renderChart(labels, values, cumulative);
}

function renderChart(labels, daily, cumulative) {
  chart?.destroy();
  const ctx = $('growthChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, 'rgba(99,102,241,.28)'); grad.addColorStop(1, 'rgba(99,102,241,0)');
  chart = new Chart(ctx, {
    data: { labels, datasets: [
      { type: 'bar', label: 'Hours / day', data: daily, backgroundColor: '#6366f1', borderRadius: 6, yAxisID: 'y' },
      { type: 'line', label: 'Cumulative growth (h)', data: cumulative, borderColor: '#10b981',
        backgroundColor: grad, fill: true, tension: .35, pointRadius: 2, yAxisID: 'y1' },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y:  { beginAtZero: true, title: { display: true, text: 'Hours' } },
        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } },
      },
      plugins: { legend: { position: 'bottom' } },
    },
  });
}

/* ---------------- Leaderboard (yesterday, via RPC) ---------------- */
async function loadLeaderboard() {
  const { data: rows } = await db.rpc('leaderboard_yesterday');
  const list = $('leaderboard-list');
  if (!rows?.length) {
    list.innerHTML = '<li class="lb-empty">😴 No one logged study hours yesterday.</li>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = rows.map((r, i) => `
    <li class="${r.telegram_id === me.telegram_id ? 'me' : ''}">
      <span class="rank">${medals[i] || i + 1}</span>
      <span class="lb-photo">${r.photo_url ? `<img src="${r.photo_url}" alt="">` : r.name[0].toUpperCase()}</span>
      <span class="lb-name">${escapeHtml(r.name)}</span>
      <span class="lb-hours">${(+r.total_hours).toFixed(1)} h</span>
    </li>`).join('');
}

/* ---------------- Past paper grid ---------------- */
function buildSubjectTabs() {
  const subjects = STREAM_SUBJECTS[settings.stream] || STREAM_SUBJECTS.Maths;
  activeSubject = activeSubject && subjects.includes(activeSubject) ? activeSubject : subjects[0];
  $('subject-tabs').innerHTML = subjects.map(s =>
    `<button class="${s === activeSubject ? 'active' : ''}" data-subject="${s}">${s}</button>`).join('');
}

async function renderPaperGrid() {
  const currentYear = Math.min(new Date().getFullYear(), 2025);
  const { data: papers } = await db.from('past_papers')
    .select('year, status').eq('subject', activeSubject);
  const byYear = new Map((papers || []).map(p => [p.year, p]));

  let html = '';
  for (let y = currentYear; y >= 2000; y--) {
    const st = byYear.get(y)?.status || 'not done';
    const idx = STATUS_CYCLE.findIndex(c => c.status === st);
    html += `<div class="paper-cell ${STATUS_CLASS[st]}" data-year="${y}"
      title="${st}">${y}<small>${STATUS_CYCLE[idx].label}</small></div>`;
  }
  $('paper-grid').innerHTML = html;
}

async function cyclePaper(cell) {
  const year = +cell.dataset.year;
  const current = cell.querySelector('small').textContent;
  const idx = STATUS_CYCLE.findIndex(c => c.label === current);
  const next = STATUS_CYCLE[(idx + 1) % 3];

  // optimistic UI
  cell.className = `paper-cell ${STATUS_CLASS[next.status]}`;
  cell.querySelector('small').textContent = next.label;

  const { error } = await db.from('past_papers').upsert({
    user_id: me.telegram_id, subject: activeSubject, year,
    status: next.status, attempt_number: next.attempt,
  }, { onConflict: 'user_id,subject,year' });
  if (error) { toast('Update failed 😕'); renderPaperGrid(); }
  loadStats(); // refresh "papers done" counter
}

/* ---------------- Settings ---------------- */
function fillSettingsModal() {
  const options = '<option value="">— none —</option>' +
    DAY_LIST.map(d => `<option value="${d}">${d}</option>`).join('');
  for (const id of ['set-maths', 'set-physics', 'set-chemistry']) $(id).innerHTML = options;
  $('set-stream').value = settings.stream;
  $('set-maths').value = settings.maths_class_day || '';
  $('set-physics').value = settings.physics_class_day || '';
  $('set-chemistry').value = settings.chemistry_class_day || '';
}

async function saveSettings() {
  const { error } = await db.from('user_settings').upsert({
    user_id: me.telegram_id,
    stream: $('set-stream').value,
    maths_class_day: $('set-maths').value || null,
    physics_class_day: $('set-physics').value || null,
    chemistry_class_day: $('set-chemistry').value || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }).select().single().then(r => r);
  if (error) return toast('Save failed 😕');
  settings = { ...settings,
    stream: $('set-stream').value,
    maths_class_day: $('set-maths').value || null,
    physics_class_day: $('set-physics').value || null,
    chemistry_class_day: $('set-chemistry').value || null };
  buildSubjectTabs(); renderPaperGrid();
  $('settings-modal').hidden = true;
  toast('Settings saved ✅ — the bot will now prompt you on those days');
}

/* ---------------- UI wiring ---------------- */
function bindUI() {
  $('btn-logout').onclick = logout;
  $('btn-settings').onclick = () => $('settings-modal').hidden = false;
  $('settings-cancel').onclick = () => $('settings-modal').hidden = true;
  $('settings-save').onclick = saveSettings;

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('tab-dashboard').hidden = t.dataset.tab !== 'dashboard';
    $('tab-papers').hidden = t.dataset.tab !== 'papers';
  });

  $('subject-tabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-subject]');
    if (!btn) return;
    activeSubject = btn.dataset.subject;
    document.querySelectorAll('#subject-tabs button')
      .forEach(b => b.classList.toggle('active', b === btn));
    renderPaperGrid();
  });

  $('paper-grid').addEventListener('click', e => {
    const cell = e.target.closest('.paper-cell');
    if (cell) cyclePaper(cell);
  });
}

/* ---------------- utils ---------------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
