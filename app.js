/* =========================================================================
   A/L Study Tracker — app.js
   Motion + mobile overhaul:
   • openSheet/closeSheet  — backdrop fade + spring slide (transform/opacity only)
   • switchTab             — tab panels fade+slide, sliding seg indicator
   • staggerChildren()     — capped staggered list reveal (max 280ms)
   • toast/setBtnLoading   — animated toast + spinner buttons
   • Telegram BackButton closes the topmost sheet; Escape key in browser.
   NOTE: sections marked ⟪ RECONSTRUCTED ⟫ were rebuilt because the original
   paste was truncated — verify their column names / queries against your DB.
   ========================================================================= */

const CONFIG = {
  SUPABASE_URL: 'https://fidrrkzbfjbhbkgmdtpb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZHJya3piZmpiaGJrZ21kdHBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NTYxMTMsImV4cCI6MjEwMzAzMjExM30.9bya3Y6-giCxu64rEPb8EGrUx0Gj0xHWQR2IkpsC4XU',
  TELEGRAM_WEBAPP_AUTH_URL: 'https://studydash.sazindux.workers.dev/api/telegram-webapp-auth',
};
const DAY_MS = 86_400_000, SLT_OFFSET = 5.5 * 3_600_000;
const DAY_LIST = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const STREAM_SUBJECTS = {
  Maths: ['Combined Maths', 'Physics', 'Chemistry'],
  Bio:   ['Bio', 'Physics', 'Chemistry'],
};
const SUBJECT_COLORS = {
  'Combined Maths': '#2AABEE',
  'Bio':            '#3FC65A',
  'Physics':        '#F5A623',
  'Chemistry':      '#9B6BFF',
};
const SETTINGS_COLUMNS = {
  'Combined Maths': 'maths_class_day', 'Bio': 'maths_class_day',
  'Physics': 'physics_class_day', 'Chemistry': 'chemistry_class_day',
};

// ⟪ RECONSTRUCTED — adjust to your past-paper year range ⟫
const PAPER_ROUNDS = 5;
const PAPER_YEARS = (() => {
  const y = new Date().getFullYear();
  return Array.from({ length: 15 }, (_, i) => y - i);
})();
const DEFAULT_AVATAR = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Ccircle cx="12" cy="8.5" r="4" fill="%23a9b6c2"/%3E%3Cpath d="M4.5 20.5a7.5 7.5 0 0 1 15 0" fill="%23a9b6c2"/%3E%3C/svg%3E';

let db = null, me = null, settings = null;
let activePaperSubject = null, activeMarksSubject = null, activeLbPeriod = 'yesterday';
let activeRange = 14, activeChartType = 'bar';
let growthChart = null, donutChart = null, marksChart = null, analyzeChart = null;
let editingDate = null, logHours = 0;
let marksActiveTab = 'single', marksEntrySubject = null, activePaperType = 'Pure';
let marksHistoryRows = [];        // latest model_papers fetch for the active subject
let attemptEntryYear = null, attemptEntryRound = null; // paper-attempt sheet state

// ---- Past-paper attempt tracker (marks / time / weak-unit tags) ----
let paperAttemptsByYear = new Map(); // year -> paper_attempts rows, for activePaperSubject
let expandedPaperYear = null;        // year currently expanded in the paper grid (accordion)
let miniChart = null;                // Chart.js instance for the expanded card's mini chart
let weakTagPool = [];                // previously-used weak-unit tags (autocomplete source)
let selectedWeakTags = [];           // chips currently staged in the open attempt-log form

const $ = id => document.getElementById(id);
const sltDate = (d = new Date()) => new Date(d.getTime() + SLT_OFFSET).toISOString().slice(0, 10);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Telegram haptics (no-op outside Telegram / on unsupported clients)
function haptic(type = 'light') {
  try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.(type); } catch {}
}

/* ---------------- Theme ---------------- */
function initTheme() {
  const saved = localStorage.getItem('alt_theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('alt_theme', next);
  if (growthChart || donutChart || marksChart) { loadStats(); loadDonut(); renderMarksPanel(); }
}
initTheme();

/* =========================================================================
   MOTION LAYER — sheets, tabs, stagger, toast (transform/opacity only)
   ========================================================================= */

// iOS Safari quirk: :active press states only fire if a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });

// Match Chart.js animation speed to the UI motion.
if (window.Chart) Chart.defaults.animation.duration = 320;

/* ---------- Bottom sheets (backdrop fade + spring slide) ---------- */
function openSheet(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el || !el.hidden) return;
  clearTimeout(el._closeTimer);
  el.hidden = false;
  void el.offsetHeight;                    // flush layout so transitions run
  el.classList.add('open');
  document.body.classList.add('sheet-open');
  syncTgBackButton();
  haptic('light');
}

function closeSheet(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (!el || el.hidden || !el.classList.contains('open')) return;
  el.classList.remove('open');
  syncTgBackButton();
  clearTimeout(el._closeTimer);
  el._closeTimer = setTimeout(() => {      // 440ms ≈ sheet exit duration
    el.hidden = true;
    if (!document.querySelector('.sheet-backdrop.open')) {
      document.body.classList.remove('sheet-open');
    }
  }, 440);
}

function syncTgBackButton() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.BackButton) return;
  try {
    document.querySelector('.sheet-backdrop.open') ? tg.BackButton.show() : tg.BackButton.hide();
  } catch {}
}

// Back button (Telegram) / Escape (browser) closes the topmost sheet.
(function initDismiss() {
  const tg = window.Telegram?.WebApp;
  try { tg?.BackButton?.onClick(() => closeTopSheet()); } catch {}
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTopSheet(); });
  function closeTopSheet() {
    const open = [...document.querySelectorAll('.sheet-backdrop.open')];
    if (open.length) closeSheet(open[open.length - 1]);
  }
})();

// Tap the dimmed area to dismiss.
document.querySelectorAll('.sheet-backdrop').forEach(bd => {
  bd.addEventListener('click', e => { if (e.target === bd) closeSheet(bd); });
});

/* ---------- Tab switching (fade + slide-up, sliding indicator) ---------- */
const TAB_IDS = ['tab-dashboard', 'tab-papers', 'tab-leaderboard'];

function switchTab(name) {
  const target = $('tab-' + name);
  if (!target) return;
  document.querySelectorAll('.segmented .seg').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  TAB_IDS.forEach(id => {
    const sec = $(id);
    if (!sec) return;
    if (sec === target) {
      sec.hidden = false;
      sec.classList.remove('tab-enter');
      void sec.offsetWidth;                // restart the enter animation
      sec.classList.add('tab-enter');
    } else {
      sec.hidden = true;
    }
  });
  positionSegIndicator();
  window.scrollTo(0, 0);                   // tabs start at the top, like native
  haptic('light');
}

function initTabNav() {
  document.querySelectorAll('.segmented .seg').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  positionSegIndicator();
  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(positionSegIndicator);
  }, { passive: true });
  document.fonts?.ready?.then?.(() => positionSegIndicator());
}

/* Indicator glides via translateX + scaleX only (transform-origin: left). */
let segIndicatorPlaced = false;
function positionSegIndicator() {
  const ind = $('seg-indicator'), nav = document.querySelector('.segmented');
  const active = nav?.querySelector('.seg.active');
  if (!ind || !nav || !active || !nav.getBoundingClientRect().width) return;
  const segs = [...nav.querySelectorAll('.seg')];
  const baseW = segs[0].getBoundingClientRect().width;
  if (!baseW) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  const borderL = parseFloat(getComputedStyle(nav).borderLeftWidth) || 0;
  const x = btnRect.left - navRect.left - borderL;
  const k = btnRect.width / baseW;
  if (!segIndicatorPlaced) ind.style.transition = 'none';  // no fly-in on load
  ind.style.width = baseW + 'px';
  ind.style.transform = `translateX(${x}px) scaleX(${k})`;
  if (!segIndicatorPlaced) {
    void ind.offsetWidth;
    ind.style.transition = '';
    segIndicatorPlaced = true;
  }
}

/* ---------- Staggered list reveal (max 280ms — under the 300ms budget) ---------- */
function staggerChildren(container, cap = 6) {
  if (!container || !container.children.length) return;
  const kids = [...container.children];
  kids.forEach((child, i) => {
    child.classList.remove('stagger-item');
    child.style.setProperty('--stagger-i', Math.min(i, cap));
  });
  void container.offsetWidth;              // restart animations on re-render
  kids.forEach(child => child.classList.add('stagger-item'));
}

/* ---------- Toast (animated in/out) ---------- */
let _toastShowT = 0, _toastHideT = 0;
function toast(msg) {
  const el = $('toast');
  if (!el) return;
  clearTimeout(_toastShowT); clearTimeout(_toastHideT);
  el.textContent = msg;
  el.hidden = false;
  void el.offsetHeight;
  el.classList.add('show');
  _toastShowT = setTimeout(() => {
    el.classList.remove('show');
    _toastHideT = setTimeout(() => { el.hidden = true; }, 260);
  }, 2400);
}

/* ---------- Button loading spinner ---------- */
function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.html) btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>${label ? `<span>${escapeHtml(label)}</span>` : ''}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.html) { btn.innerHTML = btn.dataset.html; delete btn.dataset.html; }
  }
}

/* ---------------- Boot & auth ---------------- */
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

function boot() {
  $('theme-toggle-login')?.addEventListener('click', toggleTheme);
  $('theme-toggle')?.addEventListener('click', toggleTheme);

  // ---- Mode detection: Telegram Mini App vs regular browser ----
  const tgApp = window.Telegram?.WebApp;
  const tgUser = tgApp?.initDataUnsafe?.user;

  if (tgApp && tgUser) {
    tgApp.ready();
    tgApp.expand();
    bootTelegramWebApp(tgApp);
    return; // never render #login-view / the Telegram Login Widget in this mode
  }

  // ---- Regular browser fallback: existing alt_token / #auth flow ----
  const hash = new URLSearchParams(location.hash.slice(1)).get('auth');
  const token = hash || localStorage.getItem('alt_token');
  history.replaceState(null, '', location.pathname);
  if (!token) return; // #login-view (with the Telegram Login Widget) stays visible

  localStorage.setItem('alt_token', token);
  initSupabase(token);
  loadApp().catch(err => { console.error(err); logout(); });
}

function initSupabase(token) {
  db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

/* ---------------- Telegram Mini App auto-login ----------------
 * `initDataUnsafe` is UNVERIFIED — only used for an optimistic label.
 * The actual login always goes through `tgApp.initData` (raw, signed string)
 * verified server-side before minting the same Supabase JWT the Login
 * Widget flow uses.
 */
async function bootTelegramWebApp(tgApp) {
  const tgUser = tgApp.initDataUnsafe.user;
  showTelegramBoot(tgUser);

  const cached = localStorage.getItem('alt_token');
  if (cached && !isTokenExpired(cached)) {
    initSupabase(cached);
    try { await loadApp(); return; } catch (err) { console.error(err); localStorage.removeItem('alt_token'); }
  }

  try {
    const res = await fetch(CONFIG.TELEGRAM_WEBAPP_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tgApp.initData }),
    });
    if (!res.ok) throw new Error(`telegram-webapp-auth ${res.status}`);
    const { token } = await res.json();
    if (!token) throw new Error('telegram-webapp-auth: no token in response');

    localStorage.setItem('alt_token', token);
    initSupabase(token);

    await db.from('users').upsert({
      telegram_id: tgUser.id,
      name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '),
      photo_url: tgUser.photo_url || null,
    }, { onConflict: 'telegram_id' });

    await loadApp();
  } catch (err) {
    console.error('Telegram Mini App auto-login failed, falling back to login widget', err);
    hideTelegramBoot();
    $('login-view').hidden = false;
  }
}

function isTokenExpired(token) {
  try {
    const { exp } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !exp || Date.now() >= exp * 1000;
  } catch { return true; }
}

function showTelegramBoot(tgUser) {
  const el = $('tg-boot');
  if (!el) return;
  const name = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ');
  const status = $('tg-boot-status');
  if (status) status.textContent = name ? `Signing you in as ${name}…` : 'Signing you in…';
  el.hidden = false;
}
function hideTelegramBoot() {
  const el = $('tg-boot');
  if (el) el.hidden = true;
}

async function loadApp() {
  const token = localStorage.getItem('alt_token');
  const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const { data, error } = await db.from('users').select('*').eq('telegram_id', payload.telegram_id).single();
  if (error) throw error;
  me = data;

  let { data: s } = await db.from('user_settings').select('*').eq('user_id', me.telegram_id).maybeSingle();
  if (!s) {
    ({ data: s } = await db.from('user_settings')
      .upsert({ user_id: me.telegram_id, stream: 'Maths' }, { onConflict: 'user_id' })
      .select().single());
  }
  settings = s;
  activePaperSubject = STREAM_SUBJECTS[settings.stream][0];
  activeMarksSubject = STREAM_SUBJECTS[settings.stream][0];

  hideTelegramBoot();
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  document.body.classList.add('app-ready');   // reveals the FAB with entrance
  $('user-name').textContent = me.name.split(' ')[0];
  if (me.photo_url) $('user-avatar').src = me.photo_url;

  buildPaperSubjectTabs();
  buildMarksSubjectTabs();
  renderSettingsPanel();
  bindUI();

  // Entrance: dashboard tab slides in + stat cards stagger.
  switchTab('dashboard');
  staggerChildren(document.querySelector('.stats-grid'));

  await Promise.all([
    loadStats(), loadDonut(), loadHeatmap(), loadLogFeed(),
    renderMarksPanel(), loadLeaderboard(), renderPaperGrid(),
    loadWeakTagsData(), loadWeakAreas(),
  ]);
}

function logout() { localStorage.removeItem('alt_token'); location.reload(); }

/* ================= OVERVIEW: stats + growth chart ================= */

async function loadStats() {
  const from = sltDate(new Date(Date.now() - 29 * DAY_MS));
  const { data: sessions } = await db.from('study_sessions')
    .select('session_date, study_hours').eq('subject', 'Total')
    .gte('session_date', from).order('session_date');

  const byDate = new Map((sessions || []).map(r => [r.session_date, +r.study_hours]));
  const values30 = [];
  for (let i = 29; i >= 0; i--) values30.push(byDate.get(sltDate(new Date(Date.now() - i * DAY_MS))) || 0);

  const today = values30[29];
  const last7 = values30.slice(-7).reduce((a, b) => a + b, 0);
  $('stat-today').innerHTML = `${today}<span class="unit">h</span>`;
  $('stat-week').innerHTML  = `${last7.toFixed(1)}<span class="unit">h</span>`;
  $('stat-avg').innerHTML   = `${(last7 / 7).toFixed(1)}<span class="unit">h</span>`;

  // streak: consecutive days with hours > 0, counting back from today.
  // If today isn't logged yet, skip it and count from yesterday.
  const dOrder = [...values30].reverse(); // index 0 = today
  let start = 0;
  if (dOrder[0] === 0) start = 1;
  let streak = 0;
  for (let i = start; i < dOrder.length && dOrder[i] > 0; i++) streak++;
  $('stat-streak').innerHTML = `${streak}<span class="unit">🔥</span>`;

  await updateGrowthChart();
}

async function updateGrowthChart() {
  let days;
  if (activeRange === 'all') {
    const { data: earliest } = await db.from('study_sessions')
      .select('session_date').eq('subject', 'Total').order('session_date', { ascending: true }).limit(1);
    if (earliest?.length) {
      const earliestDate = new Date(`${earliest[0].session_date}T00:00:00Z`);
      const todayDate = new Date(`${sltDate()}T00:00:00Z`);
      days = Math.min(365, Math.round((todayDate - earliestDate) / DAY_MS) + 1);
    } else days = 14;
  } else {
    days = activeRange;
  }

  const from = sltDate(new Date(Date.now() - (days - 1) * DAY_MS));
  const { data } = await db.from('study_sessions')
    .select('session_date, study_hours').eq('subject', 'Total').gte('session_date', from).order('session_date');
  const byDate = new Map((data || []).map(r => [r.session_date, +r.study_hours]));

  const labels = [], daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = sltDate(new Date(Date.now() - i * DAY_MS));
    labels.push(d.slice(5));
    daily.push(byDate.get(d) || 0);
  }
  const cumulative = []; let run = 0;
  for (const v of daily) { run += v; cumulative.push(+run.toFixed(1)); }

  renderGrowthChart(labels, daily, cumulative);
}

function chartColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return { grid: dark ? '#22303C' : '#E3E7EC', text: dark ? '#8B98A5' : '#707579', cardBg: dark ? '#17212B' : '#FFFFFF' };
}

function renderGrowthChart(labels, daily, cumulative) {
  growthChart?.destroy();
  const ctx = $('growthChart').getContext('2d');
  const c = chartColors();
  let dataset;

  if (activeChartType === 'bar') {
    dataset = { type: 'bar', label: 'Hours / day', data: daily, backgroundColor: '#2AABEE', borderRadius: 6, maxBarThickness: 22 };
  } else {
    const grad = ctx.createLinearGradient(0, 0, 0, 240);
    grad.addColorStop(0, 'rgba(42,171,238,.32)'); grad.addColorStop(1, 'rgba(42,171,238,0)');
    dataset = { type: 'line', label: 'Cumulative hours', data: cumulative, borderColor: '#2AABEE', borderWidth: 3,
      backgroundColor: grad, fill: true, tension: .45, cubicInterpolationMode: 'monotone',
      pointRadius: labels.length > 40 ? 0 : 3, pointHoverRadius: 6,
      pointBackgroundColor: '#2AABEE', pointBorderColor: c.cardBg, pointBorderWidth: 2 };
  }

  growthChart = new Chart(ctx, {
    data: { labels, datasets: [dataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { ticks: { color: c.text, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

/* ================= Subject donut ================= */

async function loadDonut() {
  const from = sltDate(new Date(Date.now() - 29 * DAY_MS));
  const { data } = await db.from('study_sessions')
    .select('subject, study_hours').neq('subject', 'Total').gte('session_date', from);

  const totals = {};
  for (const r of (data || [])) totals[r.subject] = (totals[r.subject] || 0) + +r.study_hours;
  const entries = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

  donutChart?.destroy();
  const c = chartColors();
  const donutBox = $('subjectDonut').closest('.chart-box');
  if (!entries.length) {
    $('donut-legend').innerHTML = '<li class="donut-empty">No per-subject hours logged in the last 30 days yet — split your hours next time you log.</li>';
    donutBox.style.display = 'none';
    return;
  }
  donutBox.style.display = 'block';
  const ctx = $('subjectDonut').getContext('2d');
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => +e[1].toFixed(1)),
      backgroundColor: entries.map(e => SUBJECT_COLORS[e[0]] || '#94a3b8'), borderWidth: 0 }] },
    options: { plugins: { legend: { display: false } }, cutout: '68%' },
  });
  $('donut-legend').innerHTML = entries.map(([name, hrs]) => `
    <li><span class="sw" style="background:${SUBJECT_COLORS[name] || '#94a3b8'}"></span>
      <span class="lg-name">${escapeHtml(name)}</span><span class="lg-val">${hrs.toFixed(1)}h</span></li>`).join('');
  staggerChildren($('donut-legend'), 4);
}

/* ================= Heatmap ================= */

async function loadHeatmap() {
  const from = sltDate(new Date(Date.now() - 69 * DAY_MS));
  const { data } = await db.from('study_sessions')
    .select('session_date, study_hours').eq('subject', 'Total').gte('session_date', from);
  const map = new Map((data || []).map(r => [r.session_date, +r.study_hours]));

  const todayStr = sltDate();
  const end = new Date(`${todayStr}T00:00:00Z`);
  const dates = [];
  for (let i = 69; i >= 0; i--) dates.push(new Date(end.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  const firstDow = new Date(`${dates[0]}T00:00:00Z`).getUTCDay();
  const padded = Array(firstDow).fill(null).concat(dates);

  $('heatmap').innerHTML = padded.map(d => {
    if (!d) return '<div class="hm-cell"></div>';
    const h = map.get(d) || 0;
    const lvl = h <= 0 ? 0 : h < 2 ? 1 : h < 4 ? 2 : h < 6 ? 3 : 4;
    return `<div class="hm-cell l${lvl}" title="${d}: ${h}h"></div>`;
  }).join('');
}

/* ================= Recent activity feed ================= */

async function loadLogFeed() {
  const from = sltDate(new Date(Date.now() - 13 * DAY_MS));
  const { data } = await db.from('study_sessions')
    .select('session_date, subject, study_hours').gte('session_date', from).order('session_date', { ascending: false });

  const byDate = new Map();
  for (const r of (data || [])) {
    if (!byDate.has(r.session_date)) byDate.set(r.session_date, { total: null, subjects: {} });
    const bucket = byDate.get(r.session_date);
    if (r.subject === 'Total') bucket.total = +r.study_hours;
    else bucket.subjects[r.subject] = +r.study_hours;
  }
  const entries = [...byDate.entries()].filter(([, v]) => v.total !== null).slice(0, 8);
  const feed = $('log-feed');
  if (!entries.length) {
    feed.innerHTML = '<div class="log-empty">No study hours logged yet — tap the + button to add today\'s hours.</div>';
    return;
  }
  feed.innerHTML = entries.map(([date, v]) => {
    const subjects = Object.entries(v.subjects).map(([s, h]) => {
      const color = SUBJECT_COLORS[s] || '#94a3b8';
      return `<span class="lb-subj"><i class="lb-dot" style="background:${color}"></i>${escapeHtml(s)} ${h}h</span>`;
    }).join('');
    return `<div class="log-bubble" data-date="${date}">
      <span class="lb-hours">${v.total}h</span>
      <div class="lb-info">
        <span class="lb-date">${formatDateLabel(date)}</span>
        ${subjects ? `<div class="lb-subjects">${subjects}</div>` : ''}
      </div>
      <svg class="lb-edit" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    </div>`;
  }).join('');
  staggerChildren(feed);
  feed.querySelectorAll('.log-bubble').forEach(el => el.onclick = () => openLogSheet(el.dataset.date));
}

function formatDateLabel(dateStr) {
  if (dateStr === sltDate()) return 'Today';
  if (dateStr === sltDate(new Date(Date.now() - DAY_MS))) return 'Yesterday';
  return dateStr;
}

/* ================= Quick-log bottom sheet ================= */

function openLogSheet(date) {
  editingDate = date;
  $('log-sheet-title').textContent = date === sltDate() ? 'Log study hours' : 'Edit study hours';
  $('log-sheet-date').textContent = formatDateLabel(date);

  const subjects = STREAM_SUBJECTS[settings.stream];
  $('log-subject-rows').innerHTML = subjects.map(s => `
    <div class="subject-row" data-subject="${s}">
      <span class="sr-name">${s}</span>
      <input type="number" min="0" max="24" step="0.5" value="0" />
    </div>`).join('');

  // Block Save until existing values finish loading, otherwise a quick tap
  // would overwrite saved per-subject hours with 0.
  $('log-save').disabled = true;
  logHours = 0;
  $('log-hours-display').textContent = '0';
  db.from('study_sessions').select('subject, study_hours').eq('session_date', date).then(({ data }) => {
    let total = 0, hasAny = false;
    for (const r of (data || [])) {
      hasAny = true;
      if (r.subject === 'Total') total = +r.study_hours;
      else {
        const row = $('log-subject-rows').querySelector(`[data-subject="${r.subject}"] input`);
        if (row) row.value = r.study_hours;
      }
    }
    logHours = total;
    $('log-hours-display').textContent = logHours;
    $('log-delete').hidden = !hasAny;
    $('log-save').disabled = false;
  }).catch(() => { $('log-save').disabled = false; });

  openSheet('log-sheet');
}

function setLogHours(v) {
  logHours = Math.max(0, Math.min(24, Math.round(v * 2) / 2));
  $('log-hours-display').textContent = logHours;
}

function closeLogSheet() { closeSheet('log-sheet'); }

async function saveLog() {
  const btn = $('log-save');
  setBtnLoading(btn, true, 'Saving…');
  try {
    const date = editingDate;
    const writes = [sb_upsertSession(date, 'Total', logHours)];
    $('log-subject-rows').querySelectorAll('.subject-row').forEach(row => {
      const subject = row.dataset.subject;
      const val = parseFloat(row.querySelector('input').value) || 0;
      writes.push(sb_upsertSession(date, subject, val));
    });
    await Promise.all(writes);
    closeLogSheet();
    toast(`Saved ${logHours}h for ${formatDateLabel(date)} ✅`);
    await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed()]);
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

function sb_upsertSession(date, subject, hours) {
  return db.from('study_sessions').upsert(
    { user_id: me.telegram_id, session_date: date, subject, study_hours: hours },
    { onConflict: 'user_id,session_date,subject' }
  );
}

async function deleteLog() {
  const btn = $('log-delete');
  setBtnLoading(btn, true, 'Deleting…');
  try {
    const { error } = await db.from('study_sessions')
      .delete().eq('user_id', me.telegram_id).eq('session_date', editingDate);
    if (error) { toast('Delete failed 😕'); return; }
    closeLogSheet();
    toast('Entry deleted');
    await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed()]);
  } catch (err) {
    console.error(err);
    toast('Delete failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ================= Model paper marks ================= */

function buildMarksSubjectTabs() {
  const subjects = STREAM_SUBJECTS[settings.stream];
  activeMarksSubject = subjects.includes(activeMarksSubject) ? activeMarksSubject : subjects[0];
  $('marks-subject-tabs').innerHTML = subjects.map(s =>
    `<button class="chip ${s === activeMarksSubject ? 'active' : ''}" data-subject="${s}">${s}</button>`).join('');
  $('marks-subject-tabs').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.subject === activeMarksSubject) return;
    activeMarksSubject = b.dataset.subject;
    $('marks-subject-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderMarksPanel();
  });
}

function sltWeekNumber() {
  const d = new Date(Date.now() + SLT_OFFSET);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
  const fy = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  fy.setUTCDate(fy.getUTCDate() - ((fy.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((t - fy) / (7 * 864e5));
}

// ⟪ RECONSTRUCTED — grade colour mapping + grade band plugin ⟫
function gradeHex(m) {
  if (m == null) return '#94a3b8';
  if (m >= 75) return '#3FC65A';   // A
  if (m >= 65) return '#2AABEE';   // B
  if (m >= 35) return '#F5A623';   // C / S
  return '#E5473C';                // W
}
const gradeBandsPlugin = {
  id: 'gradeBands',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales: { y } } = chart;
    if (!chartArea) return;
    const bands = [
      { from: 75, to: 100, color: 'rgba(63,198,90,.06)' },
      { from: 65, to: 75,  color: 'rgba(42,171,238,.05)' },
      { from: 0,  to: 35,  color: 'rgba(229,71,60,.05)' },
    ];
    for (const b of bands) {
      const y1 = y.getPixelForValue(b.to), y2 = y.getPixelForValue(b.from);
      ctx.save();
      ctx.fillStyle = b.color;
      ctx.fillRect(chartArea.left, y1, chartArea.right - chartArea.left, y2 - y1);
      ctx.restore();
    }
  }
};

async function renderMarksPanel() {
  const subject = activeMarksSubject;
  const analyzeLabel = $('analyze-subject-label');
  if (analyzeLabel) analyzeLabel.textContent = `— ${subject}`;

  // Fetch ALL weeks for this subject — used for the history list, the marks
  // chart, AND the Essay/MCQ analyze chart so all three always agree.
  const { data, error } = await db.from('model_papers')
    .select('week_number, marks, essay_marks, mcq_marks, is_absent, paper_type').eq('subject', subject)
    .order('week_number', { ascending: false });
  if (error) { toast('Could not load marks 😕'); return; }
  marksHistoryRows = data || [];

  const scoredAsc = [...marksHistoryRows]
    .filter(r => !r.is_absent && r.marks !== null)
    .sort((a, b) => a.week_number - b.week_number);

  marksChart?.destroy();
  const c = chartColors();
  const ctx = $('marksChart').getContext('2d');

  if (subject === 'Combined Maths') {
    marksChart = renderCombinedMathsChart(ctx, c, scoredAsc);
  } else {
    const chartLabels = scoredAsc.map(r => `W${r.week_number}`);
    const chartData = scoredAsc.map(r => +r.marks);
    const pointColors = chartData.map(gradeHex);
    marksChart = new Chart(ctx, {
      type: 'line',
      data: { labels: chartLabels, datasets: [{ label: `${subject} marks`, data: chartData,
        borderColor: SUBJECT_COLORS[subject] || '#2AABEE', backgroundColor: 'transparent',
        tension: .42, cubicInterpolationMode: 'monotone', borderWidth: 2.5,
        pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: pointColors,
        pointBorderColor: c.cardBg, pointBorderWidth: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                  y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
        plugins: { legend: { display: false } },
        layout: { padding: { right: 18 } },
      },
      plugins: [gradeBandsPlugin],
    });
  }

  renderMarksHistory();
  renderAnalyzeChart(scoredAsc);
}

/**
 * Combined Maths gets 3 lines instead of 1: Pure, Applied, and a per-week
 * Average. The native Chart.js legend is enabled here so each line can be
 * clicked on/off.
 */
function renderCombinedMathsChart(ctx, c, scoredAsc) {
  const pureByWeek = new Map(), appliedByWeek = new Map();
  scoredAsc.forEach(r => {
    const type = r.paper_type || 'General';
    if (type === 'Pure') pureByWeek.set(r.week_number, +r.marks);
    else if (type === 'Applied') appliedByWeek.set(r.week_number, +r.marks);
  });

  const weeks = [...new Set([...pureByWeek.keys(), ...appliedByWeek.keys()])].sort((a, b) => a - b);
  const labels = weeks.map(w => `W${w}`);
  const pureData = weeks.map(w => pureByWeek.has(w) ? pureByWeek.get(w) : null);
  const appliedData = weeks.map(w => appliedByWeek.has(w) ? appliedByWeek.get(w) : null);
  const avgData = weeks.map(w => {
    const p = pureByWeek.get(w), a = appliedByWeek.get(w);
    if (p !== undefined && a !== undefined) return +((p + a) / 2).toFixed(1);
    return p !== undefined ? p : (a !== undefined ? a : null);
  });

  const lineDataset = (label, data, color, dashed = false) => ({
    label, data, borderColor: color, backgroundColor: 'transparent',
    tension: .42, cubicInterpolationMode: 'monotone', borderWidth: dashed ? 2 : 2.5,
    borderDash: dashed ? [6, 4] : [], spanGaps: true,
    pointRadius: dashed ? 3 : 4, pointHoverRadius: dashed ? 5 : 6,
    pointBackgroundColor: color, pointBorderColor: c.cardBg, pointBorderWidth: 2,
  });

  return new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      lineDataset('Pure Maths', pureData, '#2AABEE'),
      lineDataset('Applied Maths', appliedData, '#9B6BFF'),
      lineDataset('Average', avgData, '#3FC65A', true),
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: true, position: 'bottom',
        labels: { color: c.text, usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 11, weight: '600' } } } },
    },
    plugins: [gradeBandsPlugin],
  });
}

// ⟪ RECONSTRUCTED — marks history list (inside the history sheet) ⟫
function renderMarksHistory() {
  const wrap = $('marks-history');
  if (!wrap) return;
  $('marks-history-subject').textContent = `· ${activeMarksSubject}`;

  if (!marksHistoryRows.length) {
    $('marks-history-summary').textContent = '';
    wrap.innerHTML = '<div class="log-empty">No marks logged for this subject yet.</div>';
    return;
  }
  const scored = marksHistoryRows.filter(r => !r.is_absent && r.marks !== null);
  const avg = scored.length ? scored.reduce((a, r) => a + (+r.marks || 0), 0) / scored.length : null;
  const best = scored.length ? Math.max(...scored.map(r => +r.marks || 0)) : null;
  $('marks-history-summary').textContent =
    `${marksHistoryRows.length} entr${marksHistoryRows.length > 1 ? 'ies' : 'y'} · avg ${avg != null ? avg.toFixed(1) : '–'} · best ${best ?? '–'}`;

  wrap.innerHTML = marksHistoryRows.map(r => {
    const isCM = activeMarksSubject === 'Combined Maths';
    const badge = isCM && (r.paper_type === 'Pure' || r.paper_type === 'Applied') ? r.paper_type : '';
    const bits = [];
    if (r.essay_marks != null) bits.push(`Essay ${r.essay_marks}`);
    if (r.mcq_marks != null) bits.push(`MCQ ${r.mcq_marks}`);
    return `<div class="mh-row" data-week="${r.week_number}" data-type="${r.paper_type || ''}">
      <span class="mh-week">W${r.week_number}</span>
      <span class="mh-badge">${badge}</span>
      <span class="mh-marks ${r.is_absent ? 'absent' : ''}">${r.is_absent ? 'Absent' : r.marks}</span>
      <span class="mh-sub">${bits.join(' · ')}</span>
      <button class="icon-btn mh-edit" aria-label="Edit week ${r.week_number}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
    </div>`;
  }).join('');
  staggerChildren(wrap);

  wrap.querySelectorAll('.mh-row').forEach(el => el.onclick = () => {
    const r = marksHistoryRows.find(x =>
      +x.week_number === +el.dataset.week && (x.paper_type || '') === el.dataset.type);
    if (!r) return;
    openMarksSheet(activeMarksSubject, {
      week: +r.week_number, marks: r.marks, essay: r.essay_marks, mcq: r.mcq_marks,
      absent: r.is_absent,
      type: (r.paper_type === 'Pure' || r.paper_type === 'Applied') ? r.paper_type : null,
    });
  });
}

// ⟪ RECONSTRUCTED — Essay / MCQ / Total analyze chart ⟫
function renderAnalyzeChart(scoredAsc) {
  analyzeChart?.destroy();
  const rows = scoredAsc.filter(r => r.essay_marks != null || r.mcq_marks != null);
  const box = $('analyzeChart').closest('.chart-box');
  if (!rows.length) {
    $('analyze-legend').hidden = true;
    $('analyze-empty').hidden = false;
    box.style.display = 'none';
    return;
  }
  $('analyze-legend').hidden = false;
  $('analyze-empty').hidden = true;
  box.style.display = 'block';

  const c = chartColors();
  const labels = rows.map(r => `W${r.week_number}`);
  const mk = (label, key, color) => ({
    label, data: rows.map(r => r[key] == null ? null : +r[key]),
    borderColor: color, backgroundColor: 'transparent',
    tension: .4, cubicInterpolationMode: 'monotone', borderWidth: 2.5, spanGaps: true,
    pointRadius: 3, pointBackgroundColor: color, pointBorderColor: c.cardBg, pointBorderWidth: 2,
  });
  analyzeChart = new Chart($('analyzeChart').getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [
      mk('Essay', 'essay_marks', '#F5A623'),
      mk('MCQ', 'mcq_marks', '#3FC65A'),
      mk('Total', 'marks', '#2AABEE'),
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false } },
    },
  });
}

/* ================= Marks sheet (single / bulk) — ⟪ RECONSTRUCTED ⟫ ================= */

function openMarksSheet(subject, entry = null) {
  marksEntrySubject = subject;
  $('marks-sheet-title').textContent = entry ? 'Edit marks' : 'Add marks';
  $('marks-sheet-subject').textContent = `· ${subject}`;
  $('paper-type-field').hidden = subject !== 'Combined Maths';

  if (entry) {
    activePaperType = entry.type === 'Applied' ? 'Applied' : 'Pure';
    $('single-week').value = entry.week;
    $('single-marks').value = entry.marks ?? '';
    $('single-essay').value = entry.essay ?? '';
    $('single-mcq').value = entry.mcq ?? '';
    $('single-absent').checked = !!entry.absent;
  } else {
    $('single-week').value = sltWeekNumber();
    $('single-marks').value = '';
    $('single-essay').value = '';
    $('single-mcq').value = '';
    $('single-absent').checked = false;
  }
  $('paper-type-toggle').querySelectorAll('.chip').forEach(x =>
    x.classList.toggle('active', x.dataset.type === activePaperType));

  if (!$('bulk-rows').children.length) addBulkRow();
  switchMarksTab('single');
  openSheet('marks-sheet');
}

function switchMarksTab(tab) {
  marksActiveTab = tab;
  $('marks-tab-single').classList.toggle('active', tab === 'single');
  $('marks-tab-bulk').classList.toggle('active', tab === 'bulk');
  $('marks-form-single').hidden = tab !== 'single';
  $('marks-form-bulk').hidden = tab !== 'bulk';
}

function addBulkRow() {
  const row = document.createElement('div');
  row.className = 'bulk-row';
  row.innerHTML = `
    <div class="br-head">
      <button type="button" class="icon-btn br-remove" aria-label="Remove row">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <input type="number" class="br-week"  min="1" max="53" placeholder="Week #">
    <input type="number" class="br-marks" min="0" max="100" step="0.5" placeholder="Marks /100">
    <input type="number" class="br-essay" min="0" max="100" step="0.5" placeholder="Essay (opt)">
    <input type="number" class="br-mcq"   min="0" max="100" step="0.5" placeholder="MCQ (opt)">`;
  row.querySelector('.br-remove').onclick = () => row.remove();
  $('bulk-rows').appendChild(row);
}

async function saveMarks() {
  const btn = $('marks-save');
  setBtnLoading(btn, true, 'Saving…');
  try {
    const subject = marksEntrySubject || activeMarksSubject;
    // NOTE: 'General' (not NULL) for non-Combined-Maths rows so the unique
    // constraint (user_id, subject, week_number, paper_type) matches on upsert.
    const writes = [];

    if (marksActiveTab === 'single') {
      const week = parseInt($('single-week').value);
      if (!week || week < 1) { toast('Enter a week number'); setBtnLoading(btn, false); return; }
      const absent = $('single-absent').checked;
      const marks = parseFloat($('single-marks').value);
      if (!absent && isNaN(marks)) { toast('Enter marks or tick absent'); setBtnLoading(btn, false); return; }
      const essay = parseFloat($('single-essay').value);
      const mcq = parseFloat($('single-mcq').value);
      writes.push(db.from('model_papers').upsert({
        user_id: me.telegram_id, subject, week_number: week,
        marks: absent ? null : marks,
        essay_marks: isNaN(essay) ? null : essay,
        mcq_marks: isNaN(mcq) ? null : mcq,
        is_absent: absent,
        paper_type: subject === 'Combined Maths' ? activePaperType : 'General',
      }, { onConflict: 'user_id,subject,week_number,paper_type' }));
    } else {
      $('bulk-rows').querySelectorAll('.bulk-row').forEach(row => {
        const week = parseInt(row.querySelector('.br-week').value);
        if (!week || week < 1) return;               // skip incomplete rows
        const marks = parseFloat(row.querySelector('.br-marks').value);
        const essay = parseFloat(row.querySelector('.br-essay').value);
        const mcq = parseFloat(row.querySelector('.br-mcq').value);
        writes.push(db.from('model_papers').upsert({
          user_id: me.telegram_id, subject, week_number: week,
          marks: isNaN(marks) ? null : marks,
          essay_marks: isNaN(essay) ? null : essay,
          mcq_marks: isNaN(mcq) ? null : mcq,
          is_absent: isNaN(marks),
          paper_type: 'General',
        }, { onConflict: 'user_id,subject,week_number,paper_type' }));
      });
      if (!writes.length) { toast('Add at least one complete row'); setBtnLoading(btn, false); return; }
    }

    await Promise.all(writes);
    closeSheet('marks-sheet');
    toast('Marks saved ✅');
    await renderMarksPanel();
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ================= Papers tab — ⟪ RECONSTRUCTED ⟫ ================= */

function buildPaperSubjectTabs() {
  const subjects = STREAM_SUBJECTS[settings.stream];
  activePaperSubject = subjects.includes(activePaperSubject) ? activePaperSubject : subjects[0];
  $('subject-tabs').innerHTML = subjects.map(s =>
    `<button class="chip ${s === activePaperSubject ? 'active' : ''}" data-subject="${s}">${s}</button>`).join('');
  $('subject-tabs').querySelectorAll('button').forEach(b => b.onclick = () => {
    if (b.dataset.subject === activePaperSubject) return;
    activePaperSubject = b.dataset.subject;
    expandedPaperYear = null;
    miniChart?.destroy(); miniChart = null;
    $('subject-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderPaperGrid();
  });
}

async function renderPaperGrid() {
  const { data, error } = await db.from('paper_attempts')
    .select('*').eq('subject', activePaperSubject);
  if (error) { console.error(error); toast('Could not load past papers 😕'); }
  paperAttemptsByYear = new Map();
  for (const r of (data || [])) {
    const y = +r.year;
    if (!paperAttemptsByYear.has(y)) paperAttemptsByYear.set(y, []);
    paperAttemptsByYear.get(y).push(r);
  }
  paperAttemptsByYear.forEach(list => list.sort((a, b) => +a.round - +b.round));
  paintPaperGrid();
}

function paintPaperGrid(animate = true) {
  const grid = $('paper-grid');
  let html = '', attempted = 0, totalRounds = 0;

  for (const year of PAPER_YEARS) {
    const rounds = paperAttemptsByYear.get(year) || [];
    if (rounds.length) attempted++;
    totalRounds += rounds.length;
    const all = rounds.length >= PAPER_ROUNDS;
    const dots = Array.from({ length: PAPER_ROUNDS }, (_, i) => {
      const done = rounds.some(r => +r.round === i + 1);
      return `<i class="pc-dot ${done ? 'filled' : ''} ${all ? 'all' : ''}"></i>`;
    }).join('');
    html += `<button class="paper-card ${expandedPaperYear === year ? 'expanded' : ''}" data-year="${year}">
      <span class="pc-year">${year}</span>
      <div class="pc-dots">${dots}</div>
    </button>`;

    if (expandedPaperYear === year) {
      html += `<div class="paper-detail">
        <div class="pd-head">
          <h3>${year} · ${rounds.length}/${PAPER_ROUNDS} rounds</h3>
          <button class="ghost-btn" data-add-attempt="${year}">+ Add attempt</button>
        </div>
        <div class="pd-rounds">${rounds.length ? rounds.map(r => `
          <div class="pd-row" data-year="${year}" data-round="${r.round}">
            <span class="pd-round">R${r.round}</span>
            <span class="pd-marks">${r.marks ?? '–'}<small>/100</small></span>
            <span class="pd-time">${r.time_minutes ? r.time_minutes + ' min' : ''}</span>
            <span class="pd-tags">${(r.weak_units || []).map(t => `<i>${escapeHtml(t)}</i>`).join('')}</span>
          </div>`).join('') : '<div class="log-empty">No rounds logged yet for this paper.</div>'}
        </div>
        <div class="chart-box chart-box-md"><canvas id="paperMiniChart"></canvas></div>
      </div>`;
    }
  }

  grid.innerHTML = html;
  if (animate) staggerChildren(grid);

  // Progress bar — GPU scaleX, never width.
  const pct = PAPER_YEARS.length ? Math.round(attempted / PAPER_YEARS.length * 100) : 0;
  $('progress-fill').style.transform = `scaleX(${pct / 100})`;
  $('progress-pct').textContent = pct + '%';
  $('progress-label').textContent =
    `${totalRounds} of ${PAPER_YEARS.length * PAPER_ROUNDS} rounds completed`;

  // Wiring
  grid.querySelectorAll('.paper-card').forEach(card => card.onclick = () => {
    const y = +card.dataset.year;
    expandedPaperYear = expandedPaperYear === y ? null : y;
    miniChart?.destroy(); miniChart = null;
    paintPaperGrid(false);
    haptic('light');
  });
  grid.querySelectorAll('[data-add-attempt]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    openAttemptSheet(+b.dataset.addAttempt);
  });
  grid.querySelectorAll('.pd-row').forEach(row => row.onclick = () =>
    openAttemptSheet(+row.dataset.year, +row.dataset.round));

  renderMiniChart();
}

function renderMiniChart() {
  miniChart?.destroy(); miniChart = null;
  const canvas = document.getElementById('paperMiniChart');
  if (!canvas || !expandedPaperYear) return;
  const rounds = (paperAttemptsByYear.get(expandedPaperYear) || [])
    .filter(r => r.marks != null).sort((a, b) => +a.round - +b.round);
  if (rounds.length < 2) return;   // nothing meaningful to plot yet
  const c = chartColors();
  miniChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: rounds.map(r => 'R' + r.round), datasets: [{
      data: rounds.map(r => +r.marks),
      borderColor: '#2AABEE', borderWidth: 2.5, tension: .35, fill: false,
      pointBackgroundColor: rounds.map(r => gradeHex(+r.marks)),
      pointBorderColor: c.cardBg, pointBorderWidth: 2, pointRadius: 4,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false } },
    },
  });
}

/* ---- Paper attempt sheet ---- */
function openAttemptSheet(year, round) {
  const rounds = paperAttemptsByYear.get(year) || [];
  if (!round) {
    // "+ Add attempt" → pick the first free round number.
    const used = new Set(rounds.map(r => +r.round));
    round = Array.from({ length: PAPER_ROUNDS }, (_, i) => i + 1).find(n => !used.has(n));
    if (!round) { toast(`All ${PAPER_ROUNDS} rounds already logged 🎉`); return; }
  }
  attemptEntryYear = year;
  attemptEntryRound = round;

  $('attempt-sheet-title').textContent = round ? `Edit round ${round}` : 'Log round';
  $('attempt-sheet-subject').textContent = activePaperSubject;
  $('attempt-sheet-year').textContent = `${year} past paper`;

  const existing = rounds.find(r => +r.round === +round);
  $('attempt-marks').value = existing?.marks ?? '';
  $('attempt-time').value = existing?.time_minutes ?? '';
  selectedWeakTags = [...(existing?.weak_units || [])];
  renderAttemptTags();

  openSheet('attempt-sheet');
}

async function saveAttempt() {
  const btn = $('attempt-save');
  const marks = parseFloat($('attempt-marks').value);
  const time = parseInt($('attempt-time').value);
  if (isNaN(marks) && isNaN(time)) { toast('Enter marks or time'); return; }

  setBtnLoading(btn, true, 'Saving…');
  try {
    const { error } = await db.from('paper_attempts').upsert({
      user_id: me.telegram_id,
      subject: activePaperSubject,
      year: attemptEntryYear,
      round: attemptEntryRound,
      marks: isNaN(marks) ? null : marks,
      time_minutes: isNaN(time) ? null : time,
      weak_units: selectedWeakTags,
    }, { onConflict: 'user_id,subject,year,round' });
    if (error) throw error;
    closeSheet('attempt-sheet');
    toast('Round saved ✅');
    await Promise.all([renderPaperGrid(), loadWeakTagsData(), loadWeakAreas()]);
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---- Weak-unit tag input with autocomplete ---- */
function bindAttemptTagInput() {
  const input = $('attempt-tag-input'), dd = $('attempt-tag-dropdown');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { dd.hidden = true; return; }
    const matches = weakTagPool
      .filter(t => t.toLowerCase().includes(q) && !selectedWeakTags.includes(t))
      .slice(0, 6);
    const exact = weakTagPool.some(t => t.toLowerCase() === q);
    let html = matches.map(t =>
      `<button type="button" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
    if (!exact && input.value.trim()) {
      html += `<button type="button" class="add-new" data-tag="${escapeHtml(input.value.trim())}">+ Add “${escapeHtml(input.value.trim())}”</button>`;
    }
    dd.innerHTML = html;
    dd.hidden = false;
    dd.querySelectorAll('button').forEach(b => b.onclick = () => {
      addWeakTag(b.dataset.tag);
      input.value = '';
      dd.hidden = true;
      input.focus();
    });
  });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value.trim();
    if (v) { addWeakTag(v); input.value = ''; dd.hidden = true; }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.tag-input-wrap')) dd.hidden = true;
  });
}

function addWeakTag(tag) {
  tag = String(tag).trim();
  if (!tag) return;
  if (!selectedWeakTags.includes(tag)) selectedWeakTags.push(tag);
  if (!weakTagPool.includes(tag)) weakTagPool.push(tag);
  renderAttemptTags();
}

function renderAttemptTags() {
  const wrap = $('attempt-tag-chips');
  wrap.innerHTML = selectedWeakTags.map(t =>
    `<button type="button" class="tag-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`).join('');
  wrap.querySelectorAll('.tag-chip').forEach(b => b.onclick = () => {
    selectedWeakTags = selectedWeakTags.filter(t => t !== b.dataset.tag);
    renderAttemptTags();
  });
}

/* ================= Weak areas analysis — ⟪ RECONSTRUCTED ⟫ ================= */

async function loadWeakTagsData() {
  const { data } = await db.from('paper_attempts').select('weak_units');
  const set = new Set();
  for (const r of (data || [])) (r.weak_units || []).forEach(t => t && set.add(t));
  weakTagPool = [...set].sort();
}

async function loadWeakAreas() {
  const list = $('weak-areas-list');
  if (!list) return;
  const { data } = await db.from('paper_attempts').select('subject, marks, weak_units');

  const agg = new Map();
  for (const r of (data || [])) {
    for (const t of (r.weak_units || [])) {
      if (!t) continue;
      if (!agg.has(t)) agg.set(t, { count: 0, marks: [], subjects: new Set() });
      const a = agg.get(t);
      a.count++;
      a.subjects.add(r.subject);
      if (r.marks != null) a.marks.push(+r.marks);
    }
  }
  const items = [...agg.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
  if (!items.length) {
    list.innerHTML = '<div class="log-empty">No weak units tagged yet — tag them when logging past-paper rounds.</div>';
    return;
  }
  const max = items[0][1].count;
  list.innerHTML = items.map(([tag, a]) => {
    const avg = a.marks.length ? a.marks.reduce((x, y) => x + y, 0) / a.marks.length : null;
    const dots = [...a.subjects].map(s =>
      `<i class="lb-dot" style="background:${SUBJECT_COLORS[s] || '#94a3b8'}" title="${escapeHtml(s)}"></i>`).join('');
    return `<div class="weak-item">
      <div class="wi-head">
        <span class="wi-tag">${escapeHtml(tag)}</span>
        <span class="wi-meta">${dots} ${a.count} round${a.count > 1 ? 's' : ''}${avg != null ? ` · avg ${avg.toFixed(0)}` : ''}</span>
      </div>
      <div class="wi-bar"><i style="transform:scaleX(${a.count / max})"></i></div>
    </div>`;
  }).join('');
  staggerChildren(list);
}

/* ================= Leaderboard — ⟪ RECONSTRUCTED ⟫ ================= */

async function loadLeaderboard() {
  const list = $('leaderboard-list');
  if (!list) return;
  const days = activeLbPeriod === 'yesterday' ? 1 : activeLbPeriod === 'week' ? 7 : 30;
  const from = sltDate(new Date(Date.now() - (days - 1) * DAY_MS));

  const [sessRes, usersRes] = await Promise.all([
    db.from('study_sessions').select('user_id, study_hours')
      .eq('subject', 'Total').gte('session_date', from),
    db.from('users').select('telegram_id, name, photo_url'),
  ]);
  if (sessRes.error || usersRes.error) { console.error(sessRes.error || usersRes.error); return; }

  const totals = new Map();
  for (const r of (sessRes.data || [])) totals.set(r.user_id, (totals.get(r.user_id) || 0) + +r.study_hours);

  const rows = (usersRes.data || [])
    .map(u => ({ ...u, hrs: totals.get(u.telegram_id) || 0 }))
    .filter(u => u.hrs > 0)
    .sort((a, b) => b.hrs - a.hrs)
    .slice(0, 20);

  if (!rows.length) {
    list.innerHTML = '<li class="log-empty">No hours logged in this period yet — be the first!</li>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = rows.map((u, i) => `
    <li class="${u.telegram_id === me.telegram_id ? 'you' : ''}">
      <span class="lb-rank">${medals[i] || (i + 1)}</span>
      <img class="lb-avatar" src="${u.photo_url || DEFAULT_AVATAR}" alt="">
      <span class="lb-name">${escapeHtml(u.name || 'Student')}</span>
      <span class="lb-hrs">${u.hrs.toFixed(1)}h</span>
    </li>`).join('');
  staggerChildren(list);
}

/* ================= Settings — ⟪ RECONSTRUCTED ⟫ ================= */

function renderSettingsPanel() {
  const streamToggle = $('set-stream-toggle');
  streamToggle.querySelectorAll('.chip').forEach(b => {
    b.classList.toggle('active', b.dataset.stream === settings.stream);
    b.onclick = async () => {
      if (b.dataset.stream === settings.stream) return;
      settings.stream = b.dataset.stream;
      await db.from('user_settings').upsert(
        { user_id: me.telegram_id, stream: settings.stream }, { onConflict: 'user_id' });
      streamToggle.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
      activePaperSubject = STREAM_SUBJECTS[settings.stream][0];
      activeMarksSubject = STREAM_SUBJECTS[settings.stream][0];
      expandedPaperYear = null;
      miniChart?.destroy(); miniChart = null;
      buildPaperSubjectTabs();
      buildMarksSubjectTabs();
      renderClassDayPickers();
      toast('Stream updated ✅');
      await Promise.all([renderMarksPanel(), renderPaperGrid(), loadDonut(), loadLogFeed(), loadWeakAreas()]);
    };
  });
  renderClassDayPickers();
}

// Class days are stored as 0–6 ints (Monday = 0) — change here if your
// columns store day names instead.
function renderClassDayPickers() {
  const wrap = $('class-day-pickers');
  if (!wrap) return;
  const subjects = STREAM_SUBJECTS[settings.stream];
  wrap.innerHTML = subjects.map(s => {
    const col = SETTINGS_COLUMNS[s];
    const current = settings[col];
    return `<div class="day-picker">
      <span class="dp-subject">${s}</span>
      <div class="chip-toggle">
        ${DAY_LIST.map((d, i) =>
          `<button class="chip ${current === i ? 'active' : ''}" data-subject="${escapeHtml(s)}" data-col="${col}" data-day="${i}">${d.slice(0, 3)}</button>`).join('')}
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.chip').forEach(b => b.onclick = async () => {
    const col = b.dataset.col;
    const day = +b.dataset.day;
    const next = settings[col] === day ? null : day;   // tap again to clear
    settings[col] = next;
    await db.from('user_settings').upsert(
      { user_id: me.telegram_id, [col]: next }, { onConflict: 'user_id' });
    renderClassDayPickers();
    haptic('light');
  });
}

/* ================= UI wiring ================= */

function bindUI() {
  initTabNav();

  // Leaderboard period chips
  $('lb-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    if (b.dataset.period === activeLbPeriod) return;
    activeLbPeriod = b.dataset.period;
    $('lb-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    loadLeaderboard();
  });

  // Growth range + chart type
  $('range-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const v = b.dataset.range === 'all' ? 'all' : +b.dataset.range;
    if (v === activeRange) return;
    activeRange = v;
    $('range-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
  });
  $('chart-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    if (b.dataset.type === activeChartType) return;
    activeChartType = b.dataset.type;
    $('chart-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
  });

  // Sheets — openers / closers
  $('fab-log').onclick = () => openLogSheet(sltDate());
  $('growth-log-today').onclick = () => openLogSheet(sltDate());
  $('btn-view-activity').onclick = () => { loadLogFeed(); openSheet('activity-sheet'); };
  $('activity-close').onclick = () => closeSheet('activity-sheet');
  $('btn-settings').onclick = () => openSheet('settings-backdrop');
  $('settings-close').onclick = () => closeSheet('settings-backdrop');
  $('btn-logout').onclick = logout;

  // Log sheet
  $('log-cancel').onclick = closeLogSheet;
  $('log-save').onclick = saveLog;
  $('log-delete').onclick = deleteLog;
  $('log-minus').onclick = () => setLogHours(logHours - 0.5);
  $('log-plus').onclick = () => setLogHours(logHours + 0.5);

  // Marks
  $('btn-add-marks').onclick = () => openMarksSheet(activeMarksSubject);
  $('btn-marks-history').onclick = () => { renderMarksHistory(); openSheet('marks-history-sheet'); };
  $('marks-history-close').onclick = () => closeSheet('marks-history-sheet');
  $('marks-cancel').onclick = () => closeSheet('marks-sheet');
  $('marks-save').onclick = saveMarks;
  $('marks-tab-single').onclick = () => switchMarksTab('single');
  $('marks-tab-bulk').onclick = () => switchMarksTab('bulk');
  $('bulk-add-row').onclick = addBulkRow;
  $('paper-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activePaperType = b.dataset.type;
    $('paper-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
  });

  // Attempt sheet
  $('attempt-close').onclick = () => closeSheet('attempt-sheet');
  $('attempt-cancel').onclick = () => closeSheet('attempt-sheet');
  $('attempt-save').onclick = saveAttempt;
  bindAttemptTagInput();
}
