/* ================= A/L Study Tracker — app.js ================= */
const CONFIG = {
  SUPABASE_URL: 'https://fidrrkzbfjbhbkgmdtpb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpZHJya3piZmpiaGJrZ21kdHBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NTYxMTMsImV4cCI6MjEwMzAzMjExM30.9bya3Y6-giCxu64rEPb8EGrUx0Gj0xHWQR2IkpsC4XU',
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

let db = null, me = null, settings = null;
let activePaperSubject = null, activeMarksSubject = null, activeLbPeriod = 'yesterday';
let activeRange = 14, activeChartType = 'bar';
let growthChart = null, donutChart = null, marksChart = null;
let editingDate = null, logHours = 0;
let marksActiveTab = 'single', marksEntrySubject = null;
let marksHistoryRows = [];        // latest model_papers fetch for the active subject
let marksSaveDefaultHtml = null;  // pristine "Save" button markup (restored after edit mode)

const $ = id => document.getElementById(id);
const sltDate = (d = new Date()) => new Date(d.getTime() + SLT_OFFSET).toISOString().slice(0, 10);
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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

/* ---------------- Boot & auth ---------------- */
// Works whether app.js loads before or after DOMContentLoaded.
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

function boot() {
  $('theme-toggle-login')?.addEventListener('click', toggleTheme);
  $('theme-toggle')?.addEventListener('click', toggleTheme);

  const hash = new URLSearchParams(location.hash.slice(1)).get('auth');
  const token = hash || localStorage.getItem('alt_token');
  history.replaceState(null, '', location.pathname);
  if (!token) return;

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

  await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed(), renderMarksPanel(), loadLeaderboard(), renderPaperGrid()]);
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
  // FIX: if today isn't logged yet, skip it and count from yesterday
  // (previously the streak showed 0 even when yesterday was logged).
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
  return { grid: dark ? '#22303C' : '#E3E7EC', text: dark ? '#8B98A5' : '#707579' };
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
    grad.addColorStop(0, 'rgba(63,198,90,.28)'); grad.addColorStop(1, 'rgba(63,198,90,0)');
    dataset = { type: 'line', label: 'Cumulative hours', data: cumulative, borderColor: '#3FC65A',
      backgroundColor: grad, fill: true, tension: .35, pointRadius: labels.length > 40 ? 0 : 3 };
  }

  growthChart = new Chart(ctx, {
    data: { labels, datasets: [dataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: c.text, maxRotation: 0, autoSkip: true }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid } },
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
  // FIX: sort BEFORE building the chart so legend order matches segment order.
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
    const subjMeta = Object.entries(v.subjects).map(([s, h]) => `${s} ${h}h`).join(' · ');
    return `<div class="log-bubble" data-date="${date}">
      <span class="lb-hours">${v.total}h</span>
      <span class="lb-meta">${formatDateLabel(date)}${subjMeta ? ' · ' + escapeHtml(subjMeta) : ''}</span>
      <svg class="lb-edit" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
    </div>`;
  }).join('');
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

  // FIX: block Save until existing values finish loading, otherwise a quick
  // tap would overwrite saved per-subject hours with 0.
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

  $('log-sheet').hidden = false;
}

function closeLogSheet() { $('log-sheet').hidden = true; }

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

async function renderMarksPanel() {
  const subject = activeMarksSubject;

  // Fetch ALL weeks for this subject (~53 rows max) — used for both the
  // history list AND the chart, so the two can never disagree.
  const { data, error } = await db.from('model_papers')
    .select('week_number, marks, is_absent').eq('subject', subject)
    .order('week_number', { ascending: false });
  if (error) { toast('Could not load marks 😕'); return; }
  marksHistoryRows = data || [];

  // FIX: chart now plots every scored entry (sorted oldest -> newest),
  // not just weeks inside a trailing 12-week "current calendar week" window.
  // That window silently dropped any week you typed by hand that fell
  // outside it, which is why only the first entry ever showed up.
  const scoredAsc = [...marksHistoryRows]
    .filter(r => !r.is_absent && r.marks !== null)
    .sort((a, b) => a.week_number - b.week_number);
  const chartLabels = scoredAsc.map(r => `W${r.week_number}`);
  const chartData = scoredAsc.map(r => +r.marks);

  marksChart?.destroy();
  const c = chartColors();
  const ctx = $('marksChart').getContext('2d');
  marksChart = new Chart(ctx, {
    type: 'line',
    data: { labels: chartLabels, datasets: [{ label: `${subject} marks`, data: chartData,
      borderColor: SUBJECT_COLORS[subject] || '#2AABEE', backgroundColor: 'transparent', tension: .3, pointRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid } } },
      plugins: { legend: { display: false } },
      layout: { padding: { right: 18 } },
    },
    plugins: [gradeBandsPlugin],
  });

  renderMarksHistory();
}

/** A/L grading bands drawn behind the marks line: A 75+, B 65-74, C 55-64, S 35-54, W <35 */
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

async function saveMarks(subject, week, marks, isAbsent) {
  const body = { user_id: me.telegram_id, subject, week_number: week,
    marks: isAbsent ? null : (isNaN(marks) ? null : marks), is_absent: isAbsent };
  const { error } = await db.from('model_papers').upsert(body, { onConflict: 'user_id,subject,week_number' });
  if (error) { toast('Update failed 😕'); return false; }
  return true;
}

/* ---------------- Marks history list (edit / delete) ---------------- */

/** Same thresholds as gradeBandsPlugin: A ≥75, B 65–74, C 55–64, S 35–54, W <35 */
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

  const label = $('marks-history-label'), summary = $('marks-history-summary');
  const rows = marksHistoryRows;
  const scored = rows.filter(r => !r.is_absent && r.marks !== null);

  if (label) {
    if (rows.length) {
      const avg  = scored.length ? (scored.reduce((a, r) => a + +r.marks, 0) / scored.length).toFixed(1) : '—';
      const best = scored.length ? Math.max(...scored.map(r => +r.marks)) : '—';
      if (summary) summary.textContent = `avg ${avg}% · best ${best}% · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
      label.hidden = false;
    } else label.hidden = true;
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="log-empty">No marks recorded for this subject yet — tap "Add marks" to log your first paper.</div>';
    return;
  }

  const actions = r => `
    <span class="mh-actions">
      <button class="mh-btn mh-edit" type="button" aria-label="Edit week ${r.week_number}" title="Edit">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="mh-btn mh-del" type="button" aria-label="Delete week ${r.week_number}" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </span>`;

  wrap.innerHTML = rows.map(r => {
    if (r.is_absent || r.marks === null) {
      return `<div class="mh-bubble mh-is-absent" data-week="${r.week_number}">
        <span class="mh-week">W${r.week_number}</span>
        <span class="mh-marks">Absent</span>
        ${actions(r)}
      </div>`;
    }
    const g = gradeFor(+r.marks);
    return `<div class="mh-bubble" data-week="${r.week_number}">
      <span class="mh-week">W${r.week_number}</span>
      <span class="mh-marks">${+r.marks}<small>/100</small></span>
      <span class="mh-grade" style="color:${g.color}; background:${g.soft}">${g.letter}</span>
      ${actions(r)}
    </div>`;
  }).join('');
}

function handleMarksHistoryClick(e) {
  const btn = e.target.closest('.mh-btn');
  if (!btn) return;
  const week = +btn.closest('.mh-bubble').dataset.week;
  if (btn.classList.contains('mh-del')) {
    if (btn.dataset.armed === '1') deleteMarksEntry(week);  // 2nd tap = confirmed
    else armDeleteBtn(btn);                                  // 1st tap = arm
  } else {
    openMarksSheet(week);                                    // edit mode
  }
}

/** Two-tap confirm: the bin becomes a red "Delete?" pill for 3 seconds. */
function armDeleteBtn(btn) {
  document.querySelectorAll('.mh-btn[data-armed="1"]').forEach(disarmDeleteBtn); // one armed at a time
  btn.dataset.armed = '1';
  btn.dataset.origHtml = btn.innerHTML;
  btn.classList.add('mh-armed');
  btn.textContent = 'Delete?';
  setTimeout(() => { if (document.body.contains(btn)) disarmDeleteBtn(btn); }, 3000);
}
function disarmDeleteBtn(btn) {
  delete btn.dataset.armed;
  btn.classList.remove('mh-armed');
  if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
  delete btn.dataset.origHtml;
}

async function deleteMarksEntry(week) {
  const bubble = $('marks-history')?.querySelector(`.mh-bubble[data-week="${week}"]`);
  bubble?.classList.add('mh-deleting');
  const { error } = await db.from('model_papers')
    .delete()
    .eq('user_id', me.telegram_id)
    .eq('subject', activeMarksSubject)
    .eq('week_number', week);
  if (error) {
    bubble?.classList.remove('mh-deleting');
    return toast('Delete failed 😕');
  }
  toast(`Deleted week ${week} marks 🗑️`);
  renderMarksPanel(); // redraws chart + history
}

/* ---------------- Marks entry sheet (Single / Bulk) ---------------- */

function openMarksSheet(editWeek = null) {
  marksEntrySubject = activeMarksSubject;
  if (marksSaveDefaultHtml === null) marksSaveDefaultHtml = $('marks-save').innerHTML;

  // Editing an existing entry? (editWeek comes from the history list)
  const editing = (editWeek != null && typeof editWeek !== 'object')
    ? marksHistoryRows.find(r => r.week_number === +editWeek) : null;

  $('marks-sheet-subject').textContent = `— ${marksEntrySubject}`;
  $('single-week').value   = editing ? editing.week_number : sltWeekNumber();
  $('single-marks').value  = (editing && editing.marks !== null && editing.marks !== undefined) ? editing.marks : '';
  $('single-absent').checked = !!(editing && editing.is_absent);
  resetBulkRows();
  switchMarksTab('single');
  $('marks-tab-bulk').style.display = editing ? 'none' : ''; // bulk hidden while editing

  const titleEl = $('marks-sheet-title');
  if (titleEl) titleEl.textContent = editing ? 'Edit marks' : 'Add marks';
  $('marks-save').innerHTML = editing ? 'Save changes' : marksSaveDefaultHtml;

  $('marks-sheet').hidden = false;
}
function closeMarksSheet() { $('marks-sheet').hidden = true; }

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
    if (marksActiveTab === 'single') {
      const week = +$('single-week').value;
      const isAbsent = $('single-absent').checked;
      const marks = parseFloat($('single-marks').value);
      if (!week || week < 1 || week > 53) { toast('Enter a valid week number'); return; }
      if (!isAbsent && (isNaN(marks) || marks < 0 || marks > 100)) { toast('Enter marks between 0 and 100'); return; }
      const ok = await saveMarks(marksEntrySubject, week, marks, isAbsent);
      if (!ok) return;
    } else {
      const rows = [...$('bulk-rows').querySelectorAll('.bulk-row')]
        .map(r => ({ week: +r.querySelector('.b-week').value, marks: parseFloat(r.querySelector('.b-marks').value) }))
        .filter(r => r.week >= 1 && r.week <= 53 && !isNaN(r.marks) && r.marks >= 0 && r.marks <= 100);
      if (!rows.length) { toast('Add at least one valid week + marks row'); return; }
      const results = await Promise.all(rows.map(r => saveMarks(marksEntrySubject, r.week, r.marks, false)));
      if (results.some(r => !r)) return;
    }
    closeMarksSheet();
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
  });
}

async function renderPaperGrid() {
  const currentYear = Math.min(new Date().getFullYear(), 2025);
  const totalYears = currentYear - 2000 + 1;
  const { data: papers } = await db.from('past_papers')
    .select('year, attempt_number').eq('subject', activePaperSubject);
  const byYear = new Map((papers || []).map(p => [p.year, p.attempt_number || 0]));
  const doneCount = [...byYear.values()].filter(n => n > 0).length;

  $('progress-label').textContent = `${doneCount} / ${totalYears} papers done`;
  $('progress-pct').textContent = `${Math.round((doneCount / totalYears) * 100)}%`;
  $('progress-fill').style.width = `${(doneCount / totalYears) * 100}%`;

  let html = '';
  for (let y = currentYear; y >= 2000; y--) {
    const rounds = byYear.get(y) || 0;
    html += paperCardHtml(y, rounds);
  }
  $('paper-grid').innerHTML = html;
}

function paperCardHtml(year, rounds) {
  const dots = Array.from({ length: 5 }, (_, i) =>
    `<button class="pc-dot ${i < rounds ? 'filled' : ''}" data-year="${year}" data-index="${i}" aria-label="Round ${i + 1}"></button>`
  ).join('');
  return `<div class="paper-card ${rounds >= 5 ? 'pc-complete' : ''}" data-year="${year}">
    <div class="pc-year">${year}</div>
    <div class="pc-dots">${dots}</div>
  </div>`;
}

async function setPaperRounds(year, rounds) {
  const card = $('paper-grid').querySelector(`.paper-card[data-year="${year}"]`);
  if (card) {
    card.classList.toggle('pc-complete', rounds >= 5);
    card.querySelectorAll('.pc-dot').forEach((dot, i) => dot.classList.toggle('filled', i < rounds));
  }

  const status = rounds === 0 ? 'not done' : rounds === 1 ? '1st time' : '2nd time+';
  const { error } = await db.from('past_papers').upsert({
    user_id: me.telegram_id, subject: activePaperSubject, year,
    attempt_number: rounds, status,
  }, { onConflict: 'user_id,subject,year' });
  if (error) { toast('Update failed 😕'); renderPaperGrid(); return; }
  renderPaperGrid(); // refresh progress bar counts
}

function handlePaperDotClick(dot) {
  const year = +dot.dataset.year;
  const index = +dot.dataset.index; // 0-based
  const currentlyFilled = dot.closest('.paper-card').querySelectorAll('.pc-dot.filled').length;
  const next = currentlyFilled === index + 1 ? index : index + 1; // click last filled dot again -> undo one
  setPaperRounds(year, next);
}

/* ================= Leaderboard ================= */

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
}

/* ================= Settings panel ================= */

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

/* ================= UI wiring ================= */

function bindUI() {
  $('btn-logout').onclick = logout;
  $('btn-settings').onclick = () => { renderSettingsPanel(); $('settings-backdrop').hidden = false; };
  $('settings-close').onclick = () => $('settings-backdrop').hidden = true;
  $('settings-backdrop').addEventListener('click', e => { if (e.target === $('settings-backdrop')) $('settings-backdrop').hidden = true; });
  $('set-stream-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => setStream(b.dataset.stream));

  document.querySelectorAll('.seg').forEach(t => t.onclick = () => {
    document.querySelectorAll('.seg').forEach(x => x.classList.toggle('active', x === t));
    $('tab-dashboard').hidden = t.dataset.tab !== 'dashboard';
    $('tab-papers').hidden = t.dataset.tab !== 'papers';
    $('tab-leaderboard').hidden = t.dataset.tab !== 'leaderboard';
  });

  $('paper-grid').addEventListener('click', e => {
    const dot = e.target.closest('.pc-dot');
    if (dot) handlePaperDotClick(dot);
  });

  $('range-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeRange = b.dataset.range === 'all' ? 'all' : +b.dataset.range;
    $('range-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
  });

  $('chart-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeChartType = b.dataset.type;
    $('chart-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    updateGrowthChart();
  });

  $('lb-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeLbPeriod = b.dataset.period;
    $('lb-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    loadLeaderboard();
  });

  $('fab-log').onclick = () => openLogSheet(sltDate());
  $('log-cancel').onclick = closeLogSheet;
  $('log-sheet').addEventListener('click', e => { if (e.target === $('log-sheet')) closeLogSheet(); });
  $('log-save').onclick = saveLog;
  $('log-delete').onclick = deleteLog;
  $('log-minus').onclick = () => { logHours = Math.max(0, +(logHours - 0.5).toFixed(1)); $('log-hours-display').textContent = logHours; };
  $('log-plus').onclick  = () => { logHours = Math.min(24, +(logHours + 0.5).toFixed(1)); $('log-hours-display').textContent = logHours; };

  // Arrow wrapper: prevents the click Event object from being misread as `editWeek`
  $('btn-add-marks').onclick = () => openMarksSheet();
  $('marks-cancel').onclick = closeMarksSheet;
  $('marks-sheet').addEventListener('click', e => { if (e.target === $('marks-sheet')) closeMarksSheet(); });
  $('marks-save').onclick = saveMarksEntry;
  $('marks-tab-single').onclick = () => switchMarksTab('single');
  $('marks-tab-bulk').onclick = () => switchMarksTab('bulk');
  $('bulk-add-row').onclick = addBulkRow;

  // NEW: marks history edit/delete via event delegation
  $('marks-history')?.addEventListener('click', handleMarksHistoryClick);
}

/* ================= utils ================= */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

/** Toggles a spinner + label on a button and blocks double-submits. */
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
