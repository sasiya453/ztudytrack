/* ================= A/L Study Tracker — app.js ================= */
const CONFIG = {
  SUPABASE_URL: 'https://fidrrkzbfjbhbkgmdtpb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZHJya3piZmpiaGJrZ21kdHBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NTYxMTMsImV4cCI6MjEwMzAzMjExM30.9bya3Y6-giCxu64rEPb8EGrUx0Gj0xHWQR2IkpsC4XU',
  WORKER_URL: 'https://studydash.sazindux.workers.dev',
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

let db = null, me = null, settings = null;
let activePaperSubject = null, activeMarksSubject = null, activeLbPeriod = 'yesterday';
let activeRange = 14, activeChartType = 'bar';
let growthChart = null, donutChart = null, marksChart = null, analyzeChart = null;
let editingDate = null, logHours = 0;
let marksActiveTab = 'single', marksEntrySubject = null;
let marksHistoryRows = [];        
let marksSaveDefaultHtml = null;  
let attemptEntryYear = null, attemptEntryRound = null; 
let attemptSaveDefaultHtml = null;                     

let paperAttemptsByYear = new Map(); 
let expandedPaperYear = null;        
let miniChart = null;                
let weakTagPool = [];                
let selectedWeakTags = [];           

const PAPER_ROUNDS = 5;

const $ = id => document.getElementById(id);
const sltDate = (d = new Date()) => new Date(d.getTime() + SLT_OFFSET).toISOString().slice(0, 10);
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function haptic(type = 'light') {
  try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.(type); } catch {}
}

/* ---- ANIMATIONS: Staggered Loading & Smooth Bottom Sheets ---- */
function staggerChildren(wrap) {
  if (!wrap) return;
  const children = Array.from(wrap.children);
  children.forEach((child, i) => {
    child.style.opacity = '0';
    child.style.animation = `mhIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards ${i * 0.05}s`;
  });
}

function openSheet(id) {
  const bd = $(id);
  if (!bd) return;
  bd.hidden = false;
  haptic('light');
}

function closeSheet(id) {
  const bd = $(id);
  if (!bd) return;
  const sheet = bd.querySelector('.sheet');
  if (sheet) sheet.style.animation = 'sheetSlideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
  bd.style.animation = 'backdropFadeOut 0.3s ease forwards';
  setTimeout(() => {
    bd.hidden = true;
    if (sheet) sheet.style.animation = '';
    bd.style.animation = '';
  }, 300);
}

/* ---------------- Theme ---------------- */
function initTheme() {
  const saved = localStorage.getItem('alt_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('alt_theme', next);
  if (growthChart || donutChart || marksChart) { loadStats(); loadDonut(); renderMarksPanel(); }
}
initTheme();

/* ---------------- Boot & auth ---------------- */
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

async function boot() {
  $('theme-toggle-login')?.addEventListener('click', toggleTheme);
  $('theme-toggle')?.addEventListener('click', toggleTheme);

  const tgApp = window.Telegram?.WebApp;
  const tgUser = tgApp?.initDataUnsafe?.user;

  if (tgUser) {
    try {
      const res = await fetch(`${CONFIG.WORKER_URL}/api/telegram-webapp-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tgApp.initData })
      });
      if (!res.ok) throw new Error('Telegram Auth Failed');
      const { token } = await res.json();
      localStorage.setItem('alt_token', token);
      setupSupabaseClient(token);
      await loadApp();
    } catch (err) {
      console.error(err);
      $('login-view').hidden = false; 
    }
  } else {
    const hash = new URLSearchParams(location.hash.slice(1)).get('auth');
    const token = hash || localStorage.getItem('alt_token');
    history.replaceState(null, '', location.pathname);
    
    if (token) {
      localStorage.setItem('alt_token', token);
      setupSupabaseClient(token);
      await loadApp().catch(err => { console.error(err); logout(); });
    } else {
      $('login-view').hidden = false;
    }
  }
}

function setupSupabaseClient(token) {
  db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
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

  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('user-name').textContent = me.name.split(' ')[0];
  if (me.photo_url) $('user-avatar').src = me.photo_url;

  buildPaperSubjectTabs();
  buildMarksSubjectTabs();
  renderSettingsPanel();
  bindUI();

  await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed(), renderMarksPanel(), loadLeaderboard(), renderPaperGrid(), loadWeakTagsData()]);

  checkAndShowAIMentor();
}

function logout() { localStorage.removeItem('alt_token'); location.reload(); }

/* ================= OVERVIEW: stats + growth chart ================= */

const CHART_EVENTS = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend'];
const TOUCH_TOOLTIP_OPTS = {
  mode: 'index',
  intersect: false,
  animation: { duration: 100 },
};

function dismissChartTooltip(chart) {
  if (!chart) return;
  const showing = (chart.getActiveElements?.().length || 0) > 0
    || (chart.tooltip?.getActiveElements?.().length || 0) > 0;
  if (!showing) return;
  chart.setActiveElements([]);
  chart.tooltip?.setActiveElements?.([], { x: 0, y: 0 });
  chart.update('none');
}

function bindTooltipDismiss(chart) {
  const cv = chart?.canvas;
  if (!cv || cv._dismissBound) return;
  cv._dismissBound = true;
  cv.addEventListener('touchend', e => {
    e.preventDefault();
    dismissChartTooltip(chart);
  }, { passive: false });
  cv.addEventListener('touchcancel', () => dismissChartTooltip(chart), { passive: true });
  cv.addEventListener('mouseleave', () => dismissChartTooltip(chart), { passive: true });
}

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

  const dOrder = [...values30].reverse();
  let start = dOrder[0] === 0 ? 1 : 0;
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
      events: CHART_EVENTS,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { ticks: { color: c.text, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } },
      },
      plugins: { legend: { display: false }, tooltip: TOUCH_TOOLTIP_OPTS },
    },
  });
  bindTooltipDismiss(growthChart);
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
  const donutBox = $('subjectDonut').closest('.chart-box');
  if (!entries.length) {
    $('donut-legend').innerHTML = '<li class="donut-empty">No per-subject hours logged in the last 30 days yet.</li>';
    donutBox.style.display = 'none';
    return;
  }
  donutBox.style.display = 'block';
  const ctx = $('subjectDonut').getContext('2d');
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => +e[1].toFixed(1)),
      backgroundColor: entries.map(e => SUBJECT_COLORS[e[0]] || '#94a3b8'), borderWidth: 0 }] },
    options: { plugins: { legend: { display: false }, tooltip: { ...TOUCH_TOOLTIP_OPTS, mode: 'nearest', intersect: true } }, cutout: '68%' },
  });
  bindTooltipDismiss(donutChart);
  
  $('donut-legend').innerHTML = entries.map(([name, hrs]) => `
    <li><span class="sw" style="background:${SUBJECT_COLORS[name] || '#94a3b8'}"></span>
      <span class="lg-name">${escapeHtml(name)}</span><span class="lg-val">${hrs.toFixed(1)}h</span></li>`).join('');
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
    feed.innerHTML = '<div class="log-empty">No study hours logged yet.</div>';
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
  
  feed.querySelectorAll('.log-bubble').forEach(el => el.onclick = () => openLogSheet(el.dataset.date));
  staggerChildren(feed);
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

  $('log-save').disabled = true;
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
    closeSheet('log-sheet');
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
    closeSheet('log-sheet');
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
    activeMarksSubject = b.dataset.subject;
    $('marks-subject-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderMarksPanel();
    haptic('light');
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

async function renderMarksPanel() {
  const subject = activeMarksSubject;
  const analyzeLabel = $('analyze-subject-label');
  if (analyzeLabel) analyzeLabel.textContent = `— ${subject}`;

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
        events: CHART_EVENTS,
        interaction: { intersect: false, mode: 'index' },
        scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                  y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
        plugins: { legend: { display: false }, tooltip: TOUCH_TOOLTIP_OPTS },
        layout: { padding: { right: 18 } },
      },
      plugins: [gradeBandsPlugin],
    });
    bindTooltipDismiss(marksChart);
  }

  renderMarksHistory();
  renderAnalyzeChart(scoredAsc);
}

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

  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      lineDataset('Pure Maths', pureData, '#2AABEE'),
      lineDataset('Applied Maths', appliedData, '#9B6BFF'),
      lineDataset('Average', avgData, '#3FC65A', true),
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      events: CHART_EVENTS,
      interaction: { intersect: false, mode: 'index' },
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: true, position: 'bottom',
        labels: { color: c.text, usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 11, weight: '600' } } },
        tooltip: TOUCH_TOOLTIP_OPTS },
    },
    plugins: [gradeBandsPlugin],
  });
  bindTooltipDismiss(chart);
  return chart;
}

function gradeHex(marks) {
  if (marks >= 75) return '#3FC65A';
  if (marks >= 65) return '#2AABEE';
  if (marks >= 55) return '#F5A623';
  if (marks >= 35) return '#F5A623';
  return '#E5473C';
}

const gradeBandsPlugin = {
  id: 'gradeBands',
  beforeDraw(chart) {
    const { ctx, chartArea, scales: { y } } = chart;
    if (!chartArea) return;
    const bands = [
      { from: 75, to: 100, color: 'rgba(63,198,90,.10)',  label: 'A', labelColor: '#3FC65A' },
      { from: 65, to: 75,  color: 'rgba(42,171,238,.10)', label: 'B', labelColor: '#2AABEE' },
      { from: 55, to: 65,  color: 'rgba(245,166,35,.12)', label: 'C', labelColor: '#F5A623' },
      { from: 35, to: 55,  color: 'rgba(245,166,35,.06)', label: 'S', labelColor: '#F5A623' },
      { from: 0,  to: 35,  color: 'rgba(229,71,60,.10)',  label: 'W', labelColor: '#E5473C' },
    ];
    ctx.save();
    bands.forEach(b => {
      const yTop = y.getPixelForValue(b.to), yBottom = y.getPixelForValue(b.from);
      ctx.fillStyle = b.color;
      ctx.fillRect(chartArea.left, yTop, chartArea.right - chartArea.left, yBottom - yTop);
      ctx.fillStyle = b.labelColor;
      ctx.font = '700 10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(b.label, chartArea.right + 3, yTop + 10);
    });
    ctx.restore();
  },
};

async function saveMarks(subject, week, marks, isAbsent, essay = null, mcq = null, paperType = 'General') {
  const body = { user_id: me.telegram_id, subject, week_number: week, paper_type: paperType,
    marks: isAbsent ? null : (isNaN(marks) ? null : marks),
    essay_marks: isAbsent || essay === null || isNaN(essay) ? null : essay,
    mcq_marks: isAbsent || mcq === null || isNaN(mcq) ? null : mcq,
    is_absent: isAbsent };
  const { error } = await db.from('model_papers').upsert(body, { onConflict: 'user_id,subject,week_number,paper_type' });
  if (error) { toast('Update failed 😕'); return false; }
  return true;
}

function renderAnalyzeChart(scoredAsc) {
  const withBreakdown = scoredAsc.filter(r => r.essay_marks !== null || r.mcq_marks !== null);
  analyzeChart?.destroy();

  if (!withBreakdown.length) {
    $('analyzeChart').style.display = 'none';
    $('analyze-legend').hidden = true;
    $('analyze-empty').hidden = false;
    return;
  }
  $('analyzeChart').style.display = 'block';
  $('analyze-legend').hidden = false;
  $('analyze-empty').hidden = true;

  const c = chartColors();
  const ctx = $('analyzeChart').getContext('2d');
  const labels = withBreakdown.map(r => `W${r.week_number}`);
  const mk = (label, key, color) => {
    const data = withBreakdown.map(r => r[key] ?? null);
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, `${color}29`); grad.addColorStop(1, `${color}00`);
    return { label, data, borderColor: color, backgroundColor: grad, fill: true,
      tension: .42, cubicInterpolationMode: 'monotone', borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 };
  };
  analyzeChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      mk('Essay', 'essay_marks', '#F5A623'),
      mk('MCQ', 'mcq_marks', '#3FC65A'),
      mk('Total', 'marks', '#2AABEE'),
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      events: CHART_EVENTS,
      interaction: { intersect: false, mode: 'index' },
      spanGaps: true,
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false }, tooltip: TOUCH_TOOLTIP_OPTS },
    },
  });
  bindTooltipDismiss(analyzeChart);
}

/* ---------------- Marks history list (edit / delete) ---------------- */

function gradeFor(marks) {
  if (marks >= 75) return { letter: 'A', color: 'var(--green)',    soft: 'var(--green-soft)' };
  if (marks >= 65) return { letter: 'B', color: 'var(--accent-a)', soft: 'var(--accent-soft)' };
  if (marks >= 55) return { letter: 'C', color: 'var(--amber)',    soft: 'var(--amber-soft)' };
  if (marks >= 35) return { letter: 'S', color: 'var(--amber)',    soft: 'var(--amber-soft)' };
  return               { letter: 'W', color: 'var(--danger)',   soft: 'var(--danger-soft)' };
}

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

  const pencilSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  const trashSvg  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>`;

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
      <span class="mh-actions">
        <button class="icon-btn mh-edit" aria-label="Edit week ${r.week_number}">${pencilSvg}</button>
        <button class="icon-btn mh-del" aria-label="Delete week ${r.week_number}">${trashSvg}</button>
      </span>
    </div>`;
  }).join('');
  staggerChildren(wrap);

  const openRowEdit = el => {
    const r = marksHistoryRows.find(x =>
      +x.week_number === +el.dataset.week && (x.paper_type || '') === el.dataset.type);
    if (!r) return;
    openMarksSheet(+r.week_number, (r.paper_type === 'Pure' || r.paper_type === 'Applied') ? r.paper_type : null);
  };

  wrap.querySelectorAll('.mh-row').forEach(el => el.onclick = () => openRowEdit(el));

  wrap.querySelectorAll('.mh-edit').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    openRowEdit(btn.closest('.mh-row'));
  });

  wrap.querySelectorAll('.mh-del').forEach(btn => btn.onclick = async e => {
    e.stopPropagation();
    if (!btn.classList.contains('confirm')) {
      btn.classList.add('confirm');
      haptic('light');
      toast('Tap delete again to confirm');
      setTimeout(() => btn.classList.remove('confirm'), 2500);
      return;
    }
    const row = btn.closest('.mh-row');
    await deleteMarksEntry(+row.dataset.week, row.dataset.type);
  });
}

async function deleteMarksEntry(week, paperType) {
  try {
    let q = db.from('model_papers').delete()
      .eq('user_id', me.telegram_id)
      .eq('subject', activeMarksSubject)
      .eq('week_number', week);
    q = paperType
      ? q.eq('paper_type', paperType)
      : q.or('paper_type.is.null,paper_type.eq.General');
    const { error } = await q;
    if (error) throw error;
    toast(`Week ${week} deleted`);
    await renderMarksPanel();
    return true;
  } catch (err) {
    console.error(err);
    toast('Delete failed 😕');
    return false;
  }
}

/* ---------------- Marks entry sheet (Single / Bulk) ---------------- */

function openMarksSheet(editWeek = null, editPaperType = null) {
  marksEntrySubject = activeMarksSubject;
  if (marksSaveDefaultHtml === null) marksSaveDefaultHtml = $('marks-save').innerHTML;

  const editing = (editWeek != null && typeof editWeek !== 'object')
    ? marksHistoryRows.find(r => r.week_number === +editWeek && (r.paper_type || 'General') === (editPaperType || 'General'))
    : null;

  $('marks-sheet-subject').textContent = `— ${marksEntrySubject}`;
  $('single-week').value   = editing ? editing.week_number : sltWeekNumber();
  $('single-marks').value  = (editing && editing.marks !== null && editing.marks !== undefined) ? editing.marks : '';
  $('single-essay').value  = (editing && editing.essay_marks !== null && editing.essay_marks !== undefined) ? editing.essay_marks : '';
  $('single-mcq').value    = (editing && editing.mcq_marks !== null && editing.mcq_marks !== undefined) ? editing.mcq_marks : '';
  $('single-absent').checked = !!(editing && editing.is_absent);

  updatePaperTypeField(editing ? (editing.paper_type || 'General') : null);

  resetBulkRows();
  switchMarksTab('single');
  $('marks-tab-bulk').style.display = editing ? 'none' : ''; 

  const titleEl = $('marks-sheet-title');
  if (titleEl) titleEl.textContent = editing ? 'Edit marks' : 'Add marks';
  $('marks-save').innerHTML = editing ? 'Save changes' : marksSaveDefaultHtml;

  openSheet('marks-sheet');
}

function updatePaperTypeField(presetType = null) {
  const field = $('paper-type-field');
  if (!field) return;
  const isMaths = marksEntrySubject === 'Combined Maths';
  field.hidden = !isMaths;
  if (isMaths) {
    const type = presetType === 'Applied' ? 'Applied' : 'Pure'; 
    $('paper-type-toggle').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  }
}
function getSelectedPaperType() {
  if (marksEntrySubject !== 'Combined Maths') return 'General';
  return $('paper-type-toggle').querySelector('.chip.active')?.dataset.type || 'Pure';
}

function openMarksHistorySheet() {
  const sub = $('marks-history-subject');
  if (sub) sub.textContent = `— ${activeMarksSubject}`;
  openSheet('marks-history-sheet');
}

function switchMarksTab(tab) {
  marksActiveTab = tab;
  $('marks-tab-single').classList.toggle('active', tab === 'single');
  $('marks-tab-bulk').classList.toggle('active', tab === 'bulk');
  $('marks-form-single').hidden = tab !== 'single';
  $('marks-form-bulk').hidden = tab !== 'bulk';
}

function bulkRowHtml() {
  return `<div class="bulk-row">
    <div class="bulk-cell"><input type="number" min="1" max="53" placeholder="Week" class="b-week" /></div>
    <div class="bulk-cell"><input type="number" min="0" max="100" step="0.5" placeholder="Marks" class="b-marks" /></div>
    <button class="bulk-del" type="button">×</button>
  </div>`;
}
function resetBulkRows() {
  $('bulk-rows').innerHTML = bulkRowHtml() + bulkRowHtml() + bulkRowHtml();
  wireBulkDeletes();
}
function addBulkRow() {
  $('bulk-rows').insertAdjacentHTML('beforeend', bulkRowHtml());
  wireBulkDeletes();
}
function wireBulkDeletes() {
  $('bulk-rows').querySelectorAll('.bulk-del').forEach(btn => btn.onclick = () => {
    if ($('bulk-rows').querySelectorAll('.bulk-row').length > 1) btn.closest('.bulk-row').remove();
  });
}

async function saveMarksEntry() {
  const btn = $('marks-save');
  setBtnLoading(btn, true, 'Saving…');
  try {
    const paperType = getSelectedPaperType();
    if (marksActiveTab === 'single') {
      const week = +$('single-week').value;
      const isAbsent = $('single-absent').checked;
      const marks = parseFloat($('single-marks').value);
      const essayRaw = $('single-essay').value.trim();
      const mcqRaw = $('single-mcq').value.trim();
      const essay = essayRaw === '' ? null : parseFloat(essayRaw);
      const mcq = mcqRaw === '' ? null : parseFloat(mcqRaw);
      if (!week || week < 1 || week > 53) { toast('Enter a valid week number'); return; }
      if (!isAbsent && (isNaN(marks) || marks < 0 || marks > 100)) { toast('Enter marks between 0 and 100'); return; }
      if (essay !== null && (isNaN(essay) || essay < 0 || essay > 100)) { toast('Essay marks must be 0–100'); return; }
      if (mcq !== null && (isNaN(mcq) || mcq < 0 || mcq > 100)) { toast('MCQ marks must be 0–100'); return; }
      const ok = await saveMarks(marksEntrySubject, week, marks, isAbsent, essay, mcq, paperType);
      if (!ok) return;
    } else {
      const rows = [...$('bulk-rows').querySelectorAll('.bulk-row')]
        .map(r => ({ week: +r.querySelector('.b-week').value, marks: parseFloat(r.querySelector('.b-marks').value) }))
        .filter(r => r.week >= 1 && r.week <= 53 && !isNaN(r.marks) && r.marks >= 0 && r.marks <= 100);
      if (!rows.length) { toast('Add at least one valid week + marks row'); return; }
      const results = await Promise.all(rows.map(r => saveMarks(marksEntrySubject, r.week, r.marks, false, null, null, paperType)));
      if (results.some(r => !r)) return;
    }
    closeSheet('marks-sheet');
    toast('Marks saved ✅');
    if (marksEntrySubject === activeMarksSubject) renderMarksPanel();
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ================= Past paper grid ================= */

function buildPaperSubjectTabs() {
  const subjects = STREAM_SUBJECTS[settings.stream];
  activePaperSubject = subjects.includes(activePaperSubject) ? activePaperSubject : subjects[0];
  $('subject-tabs').innerHTML = subjects.map(s =>
    `<button class="chip ${s === activePaperSubject ? 'active' : ''}" data-subject="${s}">${s}</button>`).join('');
  $('subject-tabs').querySelectorAll('button').forEach(b => b.onclick = () => {
    activePaperSubject = b.dataset.subject;
    $('subject-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderPaperGrid();
    haptic('light');
  });
}

const HOLD_MS = 500;      
const HOLD_SLOP = 10;     
let holdToggleBusy = false;

function bindPaperCardHold(card) {
  let holdTimer = 0, startX = 0, startY = 0, holdFired = false;

  const start = (x, y) => {
    if (card.classList.contains('pc-expanded')) return;
    holdFired = false;
    startX = x; startY = y;
    card.classList.add('holding');                  
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdFired = true;                             
      card.classList.remove('holding');
      card.classList.add('fired');
      setTimeout(() => card.classList.remove('fired'), 340);
      haptic('medium');                             
      quickTogglePaperDots(Number(card.dataset.year));
    }, HOLD_MS);
  };
  
  const cancel = () => {
    clearTimeout(holdTimer);
    card.classList.remove('holding');
  };

  card.addEventListener('touchstart', e => {
    const t = e.touches[0];
    start(t.clientX, t.clientY);
  }, { passive: true });
  card.addEventListener('touchmove', e => {        
    const t = e.touches[0];
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > HOLD_SLOP) cancel();
  }, { passive: true });
  card.addEventListener('touchend', cancel);
  card.addEventListener('touchcancel', cancel);

  card.addEventListener('mousedown', e => start(e.clientX, e.clientY));
  card.addEventListener('mouseup', cancel);
  card.addEventListener('mouseleave', cancel);

  card.addEventListener('contextmenu', e => {
     if (!card.classList.contains('pc-expanded')) e.preventDefault();
  });
  card.addEventListener('dragstart', e => e.preventDefault());

  card.addEventListener('click', (e) => {
    if (holdFired) { holdFired = false; return; }
    
    const y = +card.dataset.year;
    const isOpen = card.classList.contains('pc-expanded');

    if (isOpen) {
      if (e.target.closest('.pa-history, .pa-add-btn')) return;
      collapsePaperCard(y);
      haptic('light');
    } else {
      expandPaperCard(card, y);
      haptic('light');
    }
  });
}

async function quickTogglePaperDots(year) {
  if (holdToggleBusy) return;                       
  holdToggleBusy = true;
  try {
    const rounds = paperAttemptsByYear.get(year) || [];
    if (rounds.length >= PAPER_ROUNDS) {
      const { error } = await db.from('paper_attempts').delete()
        .eq('user_id', me.telegram_id)
        .eq('subject', activePaperSubject)
        .eq('year', year);
      if (error) throw error;
      toast(`${year} · rounds reset to 0`);
    } else {
      const nextRound = rounds.reduce((m, r) => Math.max(m, +r.round_number || +r.round || 0), 0) + 1;
      if (nextRound > PAPER_ROUNDS) return;
      const { error } = await db.from('paper_attempts').upsert({
        user_id: me.telegram_id,
        subject: activePaperSubject,
        year: Number(year),
        round_number: nextRound,
        marks: null,
        time_taken_minutes: null,
        weak_tags: [],                              
      }, { onConflict: 'user_id,subject,year,round_number' });
      if (error) throw error;
    }
    await renderPaperGrid(false);
    loadWeakTagsData().catch(console.error);
  } catch (err) {
    console.error(err);
    toast('Could not update rounds 😕');
  } finally {
    holdToggleBusy = false;
  }
}

async function renderPaperGrid(animate = true) {
  const currentYear = Math.min(new Date().getFullYear(), 2030);
  const totalYears = currentYear - 2000 + 1;

  const [{ data: papers }, { data: attempts }] = await Promise.all([
    db.from('past_papers').select('year, attempt_number').eq('subject', activePaperSubject),
    db.from('paper_attempts')
      .select('year, round_number, marks, time_taken_minutes, weak_tags')
      .eq('subject', activePaperSubject).order('round_number', { ascending: true }),
  ]);
  const byYear = new Map((papers || []).map(p => [p.year, p.attempt_number || 0]));
  const doneCount = [...byYear.values()].filter(n => n > 0).length;

  paperAttemptsByYear = new Map();
  for (const a of (attempts || [])) {
    if (!paperAttemptsByYear.has(a.year)) paperAttemptsByYear.set(a.year, []);
    paperAttemptsByYear.get(a.year).push(a);
  }

  $('progress-label').textContent = `${doneCount} / ${totalYears} papers done`;
  $('progress-pct').textContent = `${Math.round((doneCount / totalYears) * 100)}%`;
  $('progress-fill').style.width = `${(doneCount / totalYears) * 100}%`;

  let html = '';
  for (let y = currentYear; y >= 2000; y--) {
    const roundsList = paperAttemptsByYear.get(y) || [];
    const rounds = Math.max(byYear.get(y) || 0, roundsList.length);
    html += paperCardHtml(y, rounds);
  }
  
  $('paper-grid').innerHTML = html;
  $('paper-grid').querySelectorAll('.paper-card').forEach(bindPaperCardHold);
  
  if(expandedPaperYear) {
    const reopenCard = $('paper-grid').querySelector(`.paper-card[data-year="${expandedPaperYear}"]`);
    if (reopenCard) expandPaperCard(reopenCard, expandedPaperYear);
  }
}

function paperCardHtml(year, rounds) {
  const dots = Array.from({ length: 5 }, (_, i) =>
    `<button class="pc-dot ${i < rounds ? 'filled' : ''}" data-year="${year}" data-index="${i}" aria-label="Round ${i + 1}"></button>`
  ).join('');
  return `<div class="paper-card ${rounds >= 5 ? 'pc-complete' : ''}" data-year="${year}">
    <div class="pc-head">
      <div class="pc-year">${year}</div>
      <div class="pc-dots">${dots}</div>
    </div>
    <div class="pc-expand"><div class="pc-expand-inner" id="pc-expand-${year}"></div></div>
  </div>`;
}

function togglePaperCard(cardEl, year) {
  const isOpen = cardEl.classList.contains('pc-expanded');
  if (expandedPaperYear !== null && expandedPaperYear !== year) {
      collapsePaperCard(expandedPaperYear);
  }
  if (isOpen) {
      collapsePaperCard(year);
  } else {
      expandPaperCard(cardEl, year);
  }
}

function expandPaperCard(cardEl, year) {
  expandedPaperYear = year;
  const attempts = paperAttemptsByYear.get(year) || [];
  const region = $(`pc-expand-${year}`);
  
  if (region) {
    if (miniChart) { miniChart.destroy(); miniChart = null; }
    region.innerHTML = expandedCardHtml(year, attempts);
    wireExpandedCardEvents(year);
    renderMiniChart(year, attempts);
    void region.offsetWidth; 
    cardEl.classList.add('pc-expanded');
  }
}

function collapsePaperCard(year) {
  const cardEl = $('paper-grid')?.querySelector(`.paper-card[data-year="${year}"]`);
  if (cardEl) cardEl.classList.remove('pc-expanded');
  
  if (expandedPaperYear === year) {
      expandedPaperYear = null;
  }
  setTimeout(() => {
     if (expandedPaperYear === year) return; 
     const region = $(`pc-expand-${year}`);
     if (region) region.innerHTML = '';
  }, 320); 
}

function expandedCardHtml(year, attempts) {
  const historyHtml = attempts.length
    ? attempts.map(a => paperAttemptBubbleHtml(year, a)).join('')
    : '<div class="log-empty">No rounds logged yet — tap "Add attempt" to log your first round.</div>';

  return `<div class="pa-wrap">
    <div class="chart-box chart-box-sm"><canvas id="pa-chart-${year}"></canvas></div>
    <div class="section-label">Attempt history</div>
    <div class="pa-history">${historyHtml}</div>
    <button class="primary-btn pa-add-btn" type="button" id="pa-add-attempt-${year}">+ Add attempt</button>
  </div>`;
}

function paperAttemptBubbleHtml(year, a) {
  const pct = +a.marks;
  const color = gradeHex(pct);
  const g = gradeFor(pct);
  const tagsHtml = (a.weak_tags || []).map(t => `<span class="pa-tag-pill">${escapeHtml(t)}</span>`).join('');

  const pencilSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
  const trashSvg  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>`;

  return `<div class="mh-row" data-round="${a.round_number}">
      <span class="mh-week">R${a.round_number}</span>
      <span class="mh-marks">${pct}<small>/100</small></span>
      <span class="mh-grade" style="color:${g.color}; background:${g.soft}">${g.letter}</span>
      <span class="mh-sub">${a.time_taken_minutes != null ? `⏱ ${a.time_taken_minutes}m` : ''}</span>
      <span class="mh-actions">
        <button class="icon-btn pa-edit" aria-label="Edit round ${a.round_number}">${pencilSvg}</button>
        <button class="icon-btn mh-del pa-del" aria-label="Delete round ${a.round_number}">${trashSvg}</button>
      </span>
      ${tagsHtml ? `<div class="pa-tags-wrapper"><div class="pa-tags-row">${tagsHtml}</div></div>` : ''}
  </div>`;
}

function renderMiniChart(year, attempts) {
  miniChart?.destroy(); miniChart = null;
  const canvas = $(`pa-chart-${year}`);
  if (!canvas) return;
  const box = canvas.closest('.chart-box');
  const scored = [...attempts].filter(a => a.marks !== null).sort((a, b) => a.round_number - b.round_number);
  if (!scored.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';

  const c = chartColors();
  miniChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: scored.map(a => 'R' + a.round_number), datasets: [{
      data: scored.map(a => +a.marks),
      borderColor: '#2AABEE', borderWidth: 2.5, tension: .35, fill: false,
      pointBackgroundColor: scored.map(a => gradeHex(+a.marks)),
      pointBorderColor: c.cardBg, pointBorderWidth: 2, pointRadius: 4,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      events: CHART_EVENTS,
      interaction: { intersect: false, mode: 'index' },
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false }, tooltip: TOUCH_TOOLTIP_OPTS },
    },
  });
  bindTooltipDismiss(miniChart);
}

function wireExpandedCardEvents(year) {
  const region = $(`pc-expand-${year}`);
  if (!region) return;

  const historyWrap = region.querySelector('.pa-history');
  staggerChildren(historyWrap);

  region.querySelector(`#pa-add-attempt-${year}`).onclick = () => openAttemptSheet(year);

  historyWrap.addEventListener('click', async e => {
    const editBtn = e.target.closest('.pa-edit');
    const delBtn = e.target.closest('.pa-del');
    
    if (editBtn) {
      e.stopPropagation();
      const round = +editBtn.closest('.mh-row').dataset.round;
      openAttemptSheet(year, round);           
    } else if (delBtn) {
      e.stopPropagation();
      if (!delBtn.classList.contains('confirm')) {
        delBtn.classList.add('confirm');
        haptic('light');
        toast('Tap delete again to confirm');
        setTimeout(() => delBtn.classList.remove('confirm'), 2500);
        return;
      }
      const round = +delBtn.closest('.mh-row').dataset.round;
      await deletePaperAttempt(year, round);
    }
  });
}

function normalizeAttemptTags(tags) {
  if (!Array.isArray(tags)) return [];   
  return tags
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim());
}

async function saveAttemptEntry({ year, round, marks, time }) {
  const weakUnits = normalizeAttemptTags(selectedWeakTags);

  const { error } = await db.from('paper_attempts').upsert({
    user_id: me.telegram_id,
    subject: activePaperSubject,
    year,                    
    round_number: round,     
    marks: (marks == null || isNaN(marks)) ? null : marks,
    time_taken_minutes: (time == null || isNaN(time)) ? null : time,
    weak_tags: weakUnits,   
  }, { onConflict: 'user_id,subject,year,round_number' });

  if (error) {
    console.error('saveAttemptEntry:', error);   
    toast('Save failed 😕');
    return false;
  }
  return true;
}

async function fetchAttemptsForYear(year) {
  const { data, error } = await db.from('paper_attempts')
    .select('year, round_number, marks, time_taken_minutes, weak_tags')
    .eq('subject', activePaperSubject).eq('year', year)
    .order('round_number', { ascending: true });
  if (error) { toast('Could not load attempts 😕'); return []; }
  return data || [];
}

async function refreshPaperCardAttempts(year) {
  const attempts = await fetchAttemptsForYear(year);
  paperAttemptsByYear.set(year, attempts);
  const region = $(`pc-expand-${year}`);
  if (!region) return;
  region.innerHTML = expandedCardHtml(year, attempts);
  wireExpandedCardEvents(year);
  renderMiniChart(year, attempts);
}

async function deletePaperAttempt(year, round) {
  const { error } = await db.from('paper_attempts').delete()
    .eq('user_id', me.telegram_id).eq('subject', activePaperSubject).eq('year', year).eq('round_number', round);
  if (error) { toast('Delete failed 😕'); return; }
  toast(`Round ${round} deleted 🗑️`);
  await refreshPaperCardAttempts(year);
  await loadWeakTagsData();
}

function nextAttemptRound(attempts) {
  return attempts.length < 5 ? attempts.length + 1 : 5;
}

function openAttemptSheet(year, roundNumber = null) {
  attemptEntryYear = Number(year);      
  if (attemptSaveDefaultHtml === null) attemptSaveDefaultHtml = $('attempt-save').innerHTML;

  const attempts = paperAttemptsByYear.get(year) || [];
  const existing = roundNumber != null ? attempts.find(a => a.round_number === +roundNumber) : null;
  attemptEntryRound = existing ? existing.round_number : nextAttemptRound(attempts);

  $('attempt-sheet-title').textContent = existing ? `Edit round ${attemptEntryRound}` : `Log round ${attemptEntryRound}`;
  $('attempt-sheet-subject').textContent = `— ${activePaperSubject}`;
  $('attempt-sheet-year').textContent = `${year} past paper`;

  $('attempt-marks').value = existing ? existing.marks : '';
  $('attempt-time').value  = (existing && existing.time_taken_minutes != null) ? existing.time_taken_minutes : '';
  selectedWeakTags = existing ? [...(existing.weak_tags || [])] : [];
  renderAttemptTagChips();
  $('attempt-tag-input').value = '';
  $('attempt-tag-dropdown').hidden = true;
  $('attempt-save').innerHTML = existing ? 'Save changes' : attemptSaveDefaultHtml;

  openSheet('attempt-sheet');
}

function closeAttemptSheet() { closeSheet('attempt-sheet'); }

async function saveAttempt() {
  const btn = $('attempt-save');
  const marks = parseFloat($('attempt-marks').value);
  const time = parseInt($('attempt-time').value);

  const year = Number(attemptEntryYear);
  const round = Number(attemptEntryRound);
  if (!Number.isInteger(year) || year <= 0 || !Number.isInteger(round) || round <= 0) {
    toast('Missing year/round — close and reopen this sheet');
    return;
  }

  if (isNaN(marks) && isNaN(time)) { toast('Enter marks or time'); return; }

  setBtnLoading(btn, true, 'Saving…');
  try {
    const ok = await saveAttemptEntry({ year, round, marks, time });
    if (!ok) return;
    closeAttemptSheet();
    toast('Round saved ✅');
    await Promise.all([renderPaperGrid(), loadWeakTagsData()]);
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

function wireAttemptTagInput() {
  const input = $('attempt-tag-input');
  const dropdown = $('attempt-tag-dropdown');
  let highlighted = -1;

  const paintHighlight = opts => opts.forEach((o, i) => o.classList.toggle('active', i === highlighted));

  const showMatches = () => {
    const q = input.value.trim().toLowerCase();
    const pool = weakTagPool.filter(t => !selectedWeakTags.includes(t));
    const matches = (q ? pool.filter(t => t.toLowerCase().includes(q)) : pool).slice(0, 6);
    highlighted = -1;
    if (!matches.length) { dropdown.hidden = true; dropdown.innerHTML = ''; return; }
    dropdown.innerHTML = matches.map(t => `<div class="tag-opt" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`).join('');
    dropdown.hidden = false;
  };

  input.addEventListener('input', showMatches);
  input.addEventListener('focus', () => { if (weakTagPool.length) showMatches(); });
  input.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 150));

  input.addEventListener('keydown', e => {
    const opts = [...dropdown.querySelectorAll('.tag-opt')];
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); highlighted = Math.min(highlighted + 1, opts.length - 1); paintHighlight(opts); }
    else if (e.key === 'ArrowUp' && opts.length) { e.preventDefault(); highlighted = Math.max(highlighted - 1, 0); paintHighlight(opts); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted >= 0 && opts[highlighted]) addAttemptTag(opts[highlighted].dataset.tag);
      else if (input.value.trim()) addAttemptTag(input.value.trim());
    } else if (e.key === 'Escape') { dropdown.hidden = true; }
  });

  dropdown.addEventListener('mousedown', e => {
    const opt = e.target.closest('.tag-opt');
    if (opt) { e.preventDefault(); addAttemptTag(opt.dataset.tag); }
  });
}

function addAttemptTag(tag) {
  tag = tag.trim();
  if (!tag || selectedWeakTags.some(t => t.toLowerCase() === tag.toLowerCase())) return;
  selectedWeakTags.push(tag);
  renderAttemptTagChips();
  const input = $('attempt-tag-input');
  input.value = '';
  $('attempt-tag-dropdown').hidden = true;
  input.focus();
}

function renderAttemptTagChips() {
  const wrap = $('attempt-tag-chips');
  if (!wrap) return;
  wrap.innerHTML = selectedWeakTags.map(t => `
    <span class="tag-chip">${escapeHtml(t)}<button type="button" class="tag-chip-x" data-tag="${escapeHtml(t)}" aria-label="Remove ${escapeHtml(t)}">×</button></span>`).join('');
  wrap.querySelectorAll('.tag-chip-x').forEach(btn => btn.onclick = () => {
    selectedWeakTags = selectedWeakTags.filter(t => t !== btn.dataset.tag);
    renderAttemptTagChips();
  });
}

async function loadWeakTagsData() {
  const { data, error } = await db.from('paper_attempts').select('weak_tags').not('weak_tags', 'is', null);
  if (error) { console.error(error); return; }

  const counts = new Map();
  const poolSet = new Set();
  for (const row of (data || [])) {
    for (const t of (row.weak_tags || [])) {
      poolSet.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  weakTagPool = [...poolSet].sort((a, b) => a.localeCompare(b));
  renderWeakAreaAnalysis(counts);
}

function renderWeakAreaAnalysis(counts) {
  const wrap = $('weak-areas-list');
  if (!wrap) return;
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    wrap.innerHTML = '<div class="log-empty">No weak units tagged yet — tag a unit when logging a past-paper round to see your weakest areas here.</div>';
    return;
  }
  const max = entries[0][1];
  wrap.innerHTML = entries.map(([tag, count], i) => {
    const color = i === 0 ? 'var(--danger)' : i < 3 ? 'var(--amber)' : 'var(--accent-a)';
    return `<div class="wa-row">
      <span class="wa-rank">${i + 1}</span>
      <span class="wa-name" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>
      <div class="wa-track"><div class="wa-fill" style="width:${(count / max * 100).toFixed(0)}%; background:${color}"></div></div>
      <span class="wa-count">${count}×</span>
    </div>`;
  }).join('');
  staggerChildren(wrap);
}

async function loadLeaderboard() {
  const rpcName = { yesterday: 'leaderboard_yesterday', week: 'leaderboard_week', month: 'leaderboard_month' }[activeLbPeriod];
  const { data: rows, error } = await db.rpc(rpcName);
  const list = $('leaderboard-list');
  if (error) { list.innerHTML = '<li class="lb-empty">Leaderboard unavailable right now.</li>'; return; }
  if (!rows?.length) {
    const label = activeLbPeriod === 'yesterday' ? 'yesterday' : activeLbPeriod === 'week' ? 'this week' : 'this month';
    list.innerHTML = `<li class="lb-empty">😴 No one has logged study hours ${label} yet.</li>`;
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = rows.map((r, i) => `
    <li class="${r.telegram_id === me.telegram_id ? 'me' : ''}">
      <span class="rank">${medals[i] || i + 1}</span>
      <span class="lb-photo">${r.photo_url ? `<img src="${escapeHtml(r.photo_url)}" alt="">` : r.name[0].toUpperCase()}</span>
      <span class="lb-name">${escapeHtml(r.name)}</span>
      <span class="lb-hours">${(+r.total_hours).toFixed(1)} h</span>
    </li>`).join('');
  staggerChildren(list);
}

function renderSettingsPanel() {
  $('set-stream-toggle').querySelectorAll('.chip').forEach(b =>
    b.classList.toggle('active', b.dataset.stream === settings.stream));

  const groups = [
    { label: 'Combined Maths / Bio class day', key: 'maths_class_day' },
    { label: 'Physics class day', key: 'physics_class_day' },
    { label: 'Chemistry class day', key: 'chemistry_class_day' },
  ];
  $('class-day-pickers').innerHTML = groups.map(g => `
    <div class="day-picker-group" data-key="${g.key}">
      <span class="sr-name">${g.label}</span>
      <div class="day-chips">
        ${DAY_LIST.map(d => `<button class="day-chip ${settings[g.key] === d ? 'active' : ''}" data-day="${d}">${d.slice(0, 3)}</button>`).join('')}
      </div>
    </div>`).join('');

  $('class-day-pickers').querySelectorAll('.day-picker-group').forEach(group => {
    const key = group.dataset.key;
    group.querySelectorAll('.day-chip').forEach(chip => chip.onclick = async () => {
      const newVal = settings[key] === chip.dataset.day ? null : chip.dataset.day;
      settings[key] = newVal;
      group.querySelectorAll('.day-chip').forEach(c => c.classList.toggle('active', c.dataset.day === newVal));
      await saveSettingsField(key, newVal);
      haptic('light');
    });
  });
}

async function saveSettingsField(key, value) {
  const { error } = await db.from('user_settings')
    .upsert({ user_id: me.telegram_id, ...settings, [key]: value, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' });
  if (error) { toast('Save failed 😕'); return; }
  toast('Settings saved ✅');
}

async function setStream(stream) {
  settings.stream = stream;
  $('set-stream-toggle').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.stream === stream));
  await saveSettingsField('stream', stream);
  buildPaperSubjectTabs(); buildMarksSubjectTabs();
  await Promise.all([renderPaperGrid(), renderMarksPanel(), loadDonut()]);
}

function bindUI() {
  $('btn-logout').onclick = logout;
  $('ai-mentor-close')?.addEventListener('click', hideAIMentorCard);
  $('btn-settings').onclick = () => openSheet('settings-backdrop');
  $('settings-close').onclick = () => closeSheet('settings-backdrop');
  $('settings-backdrop').addEventListener('click', e => { if (e.target === $('settings-backdrop')) closeSheet('settings-backdrop'); });
  $('set-stream-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => { setStream(b.dataset.stream); haptic('light'); });

  document.querySelectorAll('.seg').forEach(t => t.onclick = () => {
    document.querySelectorAll('.seg').forEach(x => x.classList.toggle('active', x === t));
    $('tab-dashboard').hidden = t.dataset.tab !== 'dashboard';
    $('tab-papers').hidden = t.dataset.tab !== 'papers';
    $('tab-leaderboard').hidden = t.dataset.tab !== 'leaderboard';
    haptic('light');
  });

  $('range-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeRange = b.dataset.range === 'all' ? 'all' : +b.dataset.range;
    $('range-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
    haptic('light');
  });

  $('chart-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeChartType = b.dataset.type;
    $('chart-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
    haptic('light');
  });

  $('lb-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeLbPeriod = b.dataset.period;
    $('lb-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    loadLeaderboard();
    haptic('light');
  });

  $('fab-log').onclick = () => openLogSheet(sltDate());
  $('growth-log-today').onclick = () => openLogSheet(sltDate());
  $('log-cancel').onclick = closeLogSheet;
  $('log-sheet').addEventListener('click', e => { if (e.target === $('log-sheet')) closeLogSheet(); });
  $('log-save').onclick = saveLog;
  $('log-delete').onclick = deleteLog;
  $('log-minus').onclick = () => { logHours = Math.max(0, +(logHours - 0.5).toFixed(1)); $('log-hours-display').textContent = logHours; haptic('light'); };
  $('log-plus').onclick  = () => { logHours = Math.min(24, +(logHours + 0.5).toFixed(1)); $('log-hours-display').textContent = logHours; haptic('light'); };

  $('btn-add-marks').onclick = () => openMarksSheet();
  $('marks-cancel').onclick = closeMarksSheet;
  $('marks-sheet').addEventListener('click', e => { if (e.target === $('marks-sheet')) closeMarksSheet(); });
  $('marks-save').onclick = saveMarksEntry;
  $('marks-tab-single').onclick = () => { switchMarksTab('single'); haptic('light'); };
  $('marks-tab-bulk').onclick = () => { switchMarksTab('bulk'); haptic('light'); };
  $('bulk-add-row').onclick = () => { addBulkRow(); haptic('light'); };
  $('paper-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    $('paper-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    haptic('light');
  });

  $('btn-view-activity').onclick = openActivitySheet;
  $('activity-close').onclick = closeActivitySheet;
  $('activity-sheet').addEventListener('click', e => { if (e.target === $('activity-sheet')) closeActivitySheet(); });

  $('btn-marks-history').onclick = openMarksHistorySheet;
  $('marks-history-close').onclick = closeMarksHistorySheet;
  $('marks-history-sheet').addEventListener('click', e => { if (e.target === $('marks-history-sheet')) closeMarksHistorySheet(); });

  $('attempt-cancel').onclick = closeAttemptSheet;
  $('attempt-close').onclick = closeAttemptSheet;
  $('attempt-sheet').addEventListener('click', e => { if (e.target === $('attempt-sheet')) closeAttemptSheet(); });
  $('attempt-save').onclick = saveAttempt;
  wireAttemptTagInput();

  $('log-subject-rows').addEventListener('input', e => {
    if (!e.target.closest('.subject-row')) return;
    let sum = 0;
    $('log-subject-rows').querySelectorAll('.subject-row input').forEach(inp => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) sum += v;                 
    });
    logHours = +sum.toFixed(1);
    $('log-hours-display').textContent = logHours;
  });

  const recomputeTotalMarks = () => {
    const essayRaw = $('single-essay').value.trim();
    const mcqRaw = $('single-mcq').value.trim();
    if (essayRaw === '' && mcqRaw === '') return;
    const essay = parseFloat(essayRaw), mcq = parseFloat(mcqRaw);
    $('single-marks').value = +((isNaN(essay) ? 0 : essay) + (isNaN(mcq) ? 0 : mcq)).toFixed(1);
  };
  $('single-essay').addEventListener('input', recomputeTotalMarks);
  $('single-mcq').addEventListener('input', recomputeTotalMarks);
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

function setBtnLoading(btn, loading, label = 'Saving…') {
  if (!btn) return;
  if (loading) {
    btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>${label}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.origHtml !== undefined) btn.innerHTML = btn.dataset.origHtml;
    delete btn.dataset.origHtml;
  }
}

let mentorTypeTimer = null;

async function checkAndShowAIMentor() {
  try {
    if (!me || !CONFIG.WORKER_URL) return;

    const today = sltDate();
    const storageKey = `alt_lastAIPopupDate_${me.telegram_id}`;
    if (localStorage.getItem(storageKey) === today) return; 

    const token = localStorage.getItem('alt_token');
    if (!token) return;

    const res = await fetch(`${CONFIG.WORKER_URL}/api/mentor`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`mentor request failed: ${res.status}`);

    const { message } = await res.json();
    if (!message) return;

    localStorage.setItem(storageKey, today); 
    showAIMentorCard(message);
  } catch (err) {
    console.warn('AI mentor unavailable:', err); 
  }
}

function showAIMentorCard(message) {
  const card = $('ai-mentor-card');
  const textEl = $('ai-mentor-text');
  if (!card || !textEl) return;

  card.hidden = false;
  card.classList.add('typing');
  requestAnimationFrame(() => card.classList.add('show'));

  typewriterEffect(textEl, message, 22, () => card.classList.remove('typing'));
}

function hideAIMentorCard() {
  const card = $('ai-mentor-card');
  if (!card) return;
  clearInterval(mentorTypeTimer);
  card.classList.remove('show');
  setTimeout(() => { card.hidden = true; }, 400); 
}

function typewriterEffect(el, text, speed = 22, onDone) {
  clearInterval(mentorTypeTimer);
  el.textContent = '';
  let i = 0;
  mentorTypeTimer = setInterval(() => {
    el.textContent += text.charAt(i);
    i++;
    if (i >= text.length) {
      clearInterval(mentorTypeTimer);
      onDone?.();
    }
  }, speed);
}
