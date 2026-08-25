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
const SETTINGS_COLUMNS = {
  'Combined Maths': 'maths_class_day', 'Bio': 'maths_class_day',
  'Physics': 'physics_class_day', 'Chemistry': 'chemistry_class_day',
};

let db = null, me = null, settings = null;
let activePaperSubject = null, activeMarksSubject = null, activeLbPeriod = 'yesterday';
let activeRange = 14, activeChartType = 'bar';
let growthChart = null, donutChart = null, marksChart = null, analyzeChart = null;
let editingDate = null, logHours = 0;
let marksActiveTab = 'single', marksEntrySubject = null;
let marksHistoryRows = [];        // latest model_papers fetch for the active subject
let marksSaveDefaultHtml = null;  // pristine "Save" button markup (restored after edit mode)
let attemptEntryYear = null, attemptEntryRound = null; // paper-attempt sheet state
let attemptSaveDefaultHtml = null;                     // pristine "Save round" markup

// ---- Past-paper attempt tracker (marks / time / weak-unit tags) ----
let paperAttemptsByYear = new Map(); // year -> paper_attempts rows, for activePaperSubject
let expandedPaperYear = null;        // year currently expanded in the paper grid (accordion — one at a time)
let miniChart = null;                // Chart.js instance for the expanded card's mini progression chart
let weakTagPool = [];                // this user's previously-used weak-unit tags, across all subjects (autocomplete source)
let selectedWeakTags = [];           // chips currently staged in the open attempt-log form

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

  await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed(), renderMarksPanel(), loadLeaderboard(), renderPaperGrid(), loadWeakTagsData()]);

  checkAndShowAIMentor(); // fire-and-forget — never blocks the dashboard from rendering
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
    // One chip per split subject with a tiny dot in that subject's color
    // (SUBJECT_COLORS, grey fallback), shown under the date line.
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
  const analyzeLabel = $('analyze-subject-label');
  if (analyzeLabel) analyzeLabel.textContent = `— ${subject}`;

  // Fetch ALL weeks for this subject (~53 rows max, or up to 106 for Combined
  // Maths since Pure and Applied are now separate rows per week) — used for
  // the history list, the marks chart, AND the Essay/MCQ analyze chart below,
  // so none of the three can ever disagree with each other.
  const { data, error } = await db.from('model_papers')
    .select('week_number, marks, essay_marks, mcq_marks, is_absent, paper_type').eq('subject', subject)
    .order('week_number', { ascending: false });
  if (error) { toast('Could not load marks 😕'); return; }
  marksHistoryRows = data || [];

  // Chart plots every scored entry (sorted oldest -> newest), not just
  // weeks inside a trailing "current calendar week" window — any week you
  // typed by hand outside that window used to be silently dropped.
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
 * Average (mean of whichever of Pure/Applied exist that week — falls back
 * to whichever single value is present if only one was logged). The native
 * Chart.js legend is enabled here (and only here) so each line can be
 * clicked on/off — its default onClick already toggles dataset visibility.
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
      layout: { padding: { right: 18 } },
    },
    plugins: [gradeBandsPlugin],
  });
}

/** Canvas-safe hex for a mark value — same thresholds as gradeBandsPlugin/gradeFor. */
function gradeHex(marks) {
  if (marks >= 75) return '#3FC65A';
  if (marks >= 65) return '#2AABEE';
  if (marks >= 55) return '#F5A623';
  if (marks >= 35) return '#F5A623';
  return '#E5473C';
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

/* ---------------- Paper marks analyze (Essay / MCQ / Total) ---------------- */

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
  const mk = (data, color, alpha) => {
    const grad = ctx.createLinearGradient(0, 0, 0, 200);
    grad.addColorStop(0, `${color}${alpha}`); grad.addColorStop(1, `${color}00`);
    return { data, borderColor: color, backgroundColor: grad, fill: true,
      tension: .42, cubicInterpolationMode: 'monotone', borderWidth: 2, pointRadius: 3, pointHoverRadius: 5 };
  };
  analyzeChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Essay', ...mk(withBreakdown.map(r => r.essay_marks ?? null), '#F5A623', '29') },
      { label: 'MCQ',   ...mk(withBreakdown.map(r => r.mcq_marks ?? null),   '#3FC65A', '29') },
      { label: 'Total', ...mk(withBreakdown.map(r => +r.marks),              '#2AABEE', '1F') },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      spanGaps: true,
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false } },
    },
  });
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

  // The summary line now lives in the marks-history sheet header (opened via
  // the history icon next to "+ Add marks") instead of above the dashboard list.
  const summary = $('marks-history-summary');
  const rows = marksHistoryRows;
  const scored = rows.filter(r => !r.is_absent && r.marks !== null);

  if (summary) {
    if (rows.length) {
      const avg  = scored.length ? (scored.reduce((a, r) => a + +r.marks, 0) / scored.length).toFixed(1) : '—';
      const best = scored.length ? Math.max(...scored.map(r => +r.marks)) : '—';
      summary.textContent = `avg ${avg}% · best ${best}% · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`;
    } else {
      summary.textContent = 'No entries yet';
    }
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="log-empty">No marks recorded for this subject yet — tap "Add marks" to log your first paper.</div>';
    return;
  }

  const actions = r => {
    const type = r.paper_type || 'General';
    return `
    <span class="mh-actions">
      <button class="mh-btn mh-edit" type="button" data-week="${r.week_number}" data-type="${type}" aria-label="Edit week ${r.week_number}" title="Edit">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="mh-btn mh-del" type="button" data-week="${r.week_number}" data-type="${type}" aria-label="Delete week ${r.week_number}" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </span>`;
  };

  wrap.innerHTML = rows.map(r => {
    const type = r.paper_type && r.paper_type !== 'General' ? r.paper_type : '';
    const typeBadge = type ? `<span class="mh-type mh-type-${type.toLowerCase()}">${type}</span>` : '';
    if (r.is_absent || r.marks === null) {
      return `<div class="mh-bubble mh-is-absent" data-week="${r.week_number}" data-type="${r.paper_type || 'General'}">
        <div class="mh-top">
          <span class="mh-week">W${r.week_number}</span>
          ${typeBadge}
          <span class="mh-marks">Absent</span>
          ${actions(r)}
        </div>
        <div class="mh-track"><div class="mh-fill" style="width:0%"></div></div>
      </div>`;
    }
    const pct = +r.marks;
    const color = gradeHex(pct);
    const g = gradeFor(pct);
    return `<div class="mh-bubble" data-week="${r.week_number}" data-type="${r.paper_type || 'General'}">
      <div class="mh-top">
        <span class="mh-week">W${r.week_number}</span>
        ${typeBadge}
        <span class="mh-marks">${pct}<small>/100</small></span>
        <span class="mh-grade" style="color:${g.color}; background:${g.soft}">${g.letter}</span>
        ${actions(r)}
      </div>
      <div class="mh-track"><div class="mh-fill" style="width:${pct}%; background:${color}"></div></div>
    </div>`;
  }).join('');
}

function handleMarksHistoryClick(e) {
  const btn = e.target.closest('.mh-btn');
  if (!btn) return;
  const week = +btn.dataset.week;
  const type = btn.dataset.type || 'General';
  if (btn.classList.contains('mh-del')) {
    if (btn.dataset.armed === '1') deleteMarksEntry(week, type);  // 2nd tap = confirmed
    else armDeleteBtn(btn);                                        // 1st tap = arm
  } else {
    openMarksSheet(week, type);                                    // edit mode
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

async function deleteMarksEntry(week, paperType = 'General') {
  const bubble = $('marks-history')?.querySelector(`.mh-bubble[data-week="${week}"][data-type="${paperType}"]`);
  bubble?.classList.add('mh-deleting');
  const { error } = await db.from('model_papers')
    .delete()
    .eq('user_id', me.telegram_id)
    .eq('subject', activeMarksSubject)
    .eq('week_number', week)
    .eq('paper_type', paperType);
  if (error) {
    bubble?.classList.remove('mh-deleting');
    return toast('Delete failed 😕');
  }
  toast(`Deleted week ${week} marks 🗑️`);
  renderMarksPanel(); // redraws chart + history
}

/* ---------------- Marks entry sheet (Single / Bulk) ---------------- */

function openMarksSheet(editWeek = null, editPaperType = null) {
  marksEntrySubject = activeMarksSubject;
  if (marksSaveDefaultHtml === null) marksSaveDefaultHtml = $('marks-save').innerHTML;

  // Editing an existing entry? (editWeek/editPaperType come from the history
  // list — Combined Maths can have two rows sharing a week number, Pure and
  // Applied, so both fields together identify the exact row being edited.)
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
  $('marks-tab-bulk').style.display = editing ? 'none' : ''; // bulk hidden while editing

  const titleEl = $('marks-sheet-title');
  if (titleEl) titleEl.textContent = editing ? 'Edit marks' : 'Add marks';
  $('marks-save').innerHTML = editing ? 'Save changes' : marksSaveDefaultHtml;

  $('marks-sheet').hidden = false;
}
function closeMarksSheet() { $('marks-sheet').hidden = true; }

/** Shows the Pure/Applied toggle only for Combined Maths; Physics/Chemistry
 *  always save as 'General' and never see the toggle. `presetType` pre-selects
 *  a chip when editing an existing Pure/Applied row; pass null for a fresh entry. */
function updatePaperTypeField(presetType = null) {
  const field = $('paper-type-field');
  if (!field) return;
  const isMaths = marksEntrySubject === 'Combined Maths';
  field.hidden = !isMaths;
  if (isMaths) {
    const type = presetType === 'Applied' ? 'Applied' : 'Pure'; // defaults to Pure for a fresh entry
    $('paper-type-toggle').querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  }
}
function getSelectedPaperType() {
  if (marksEntrySubject !== 'Combined Maths') return 'General';
  return $('paper-type-toggle').querySelector('.chip.active')?.dataset.type || 'Pure';
}

/* ================= List bottom sheets (recent activity / marks history) ================= */

/* Both reuse the .sheet-backdrop / .sheet pattern. They sit BEFORE the entry
   sheets (#log-sheet / #marks-sheet) in the DOM, so tapping an entry inside
   a list stacks the edit sheet on top of it; saving or cancelling reveals
   the freshly re-rendered list underneath — no extra state to track. */
function openActivitySheet() { $('activity-sheet').hidden = false; }
function closeActivitySheet() { $('activity-sheet').hidden = true; }

function openMarksHistorySheet() {
  const sub = $('marks-history-subject');
  if (sub) sub.textContent = `— ${activeMarksSubject}`;
  $('marks-history-sheet').hidden = false;
}
function closeMarksHistorySheet() { $('marks-history-sheet').hidden = true; }

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
  // Small headroom above the real current year so new A/L years show up
  // automatically without needing another code change each January.
  const currentYear = Math.min(new Date().getFullYear(), 2030);
  const totalYears = currentYear - 2000 + 1;

  // Grid is about to be rebuilt from scratch — any expanded card and its
  // chart instance are about to be detached, so drop the refs up front.
  miniChart?.destroy(); miniChart = null;
  expandedPaperYear = null;

  const [{ data: papers }, { data: attempts }] = await Promise.all([
    db.from('past_papers').select('year, attempt_number').eq('subject', activePaperSubject),
    db.from('paper_attempts')
      .select('year, round_number, marks, time_taken_minutes, weak_tags')
      .eq('subject', activePaperSubject).order('round_number', { ascending: true }),
  ]);
  const byYear = new Map((papers || []).map(p => [p.year, p.attempt_number || 0]));
  const doneCount = [...byYear.values()].filter(n => n > 0).length;

  // One fetch covers every year for this subject, so opening a card doesn't
  // need its own network round-trip — it just reads from this cache.
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
    <div class="pc-head">
      <div class="pc-year">${year}</div>
      <div class="pc-dots">${dots}</div>
    </div>
    <div class="pc-expand"><div class="pc-expand-inner" id="pc-expand-${year}"></div></div>
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

  // renderPaperGrid() rebuilds every card (needed to refresh the progress
  // bar), which would otherwise silently close an expanded card — reopen it
  // afterwards so toggling a dot doesn't kick the user out of the tracker.
  const reopenYear = expandedPaperYear;
  await renderPaperGrid();
  if (reopenYear != null) {
    const reopenCard = $('paper-grid').querySelector(`.paper-card[data-year="${reopenYear}"]`);
    if (reopenCard) expandPaperCard(reopenCard, reopenYear);
  }
}

function handlePaperDotClick(dot) {
  const year = +dot.dataset.year;
  const index = +dot.dataset.index; // 0-based
  const currentlyFilled = dot.closest('.paper-card').querySelectorAll('.pc-dot.filled').length;
  const next = currentlyFilled === index + 1 ? index : index + 1; // click last filled dot again -> undo one
  setPaperRounds(year, next);
}

/* ================= Paper attempt tracker (marks / time / weak tags) ================= */

/** Opens/closes a year's card. Only one card is expanded at a time — keeps at most one Chart.js instance alive. */
function togglePaperCard(cardEl, year) {
  const isOpen = cardEl.classList.contains('pc-expanded');
  if (expandedPaperYear !== null && expandedPaperYear !== year) collapsePaperCard(expandedPaperYear);
  isOpen ? collapsePaperCard(year) : expandPaperCard(cardEl, year);
}

function expandPaperCard(cardEl, year) {
  expandedPaperYear = year;
  cardEl.classList.add('pc-expanded');
  const attempts = paperAttemptsByYear.get(year) || [];
  const region = $(`pc-expand-${year}`);
  region.innerHTML = expandedCardHtml(year, attempts);
  wireExpandedCardEvents(year);
  renderMiniChart(year, attempts);
}

function collapsePaperCard(year) {
  const cardEl = $('paper-grid')?.querySelector(`.paper-card[data-year="${year}"]`);
  cardEl?.classList.remove('pc-expanded');
  miniChart?.destroy(); miniChart = null;
  const region = $(`pc-expand-${year}`);
  if (region) region.innerHTML = '';
  if (expandedPaperYear === year) expandedPaperYear = null;
}

function expandedCardHtml(year, attempts) {
  const historyHtml = attempts.length
    ? attempts.map(a => paperAttemptBubbleHtml(year, a)).join('')
    : '<div class="log-empty">No rounds logged yet — tap "Add attempt" to log your first round.</div>';

  // The entry form now lives in the #attempt-sheet bottom sheet (opened by
  // the button below or a history row's edit icon); the expanded card keeps
  // only the analytics chart + attempt history + completion dots above.
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
  return `<div class="mh-bubble" data-round="${a.round_number}">
    <div class="mh-top">
      <span class="mh-week">R${a.round_number}</span>
      <span class="mh-marks">${pct}<small>/100</small></span>
      <span class="mh-grade" style="color:${g.color}; background:${g.soft}">${g.letter}</span>
      ${a.time_taken_minutes != null ? `<span class="pa-time">⏱ ${a.time_taken_minutes}m</span>` : ''}
      <span class="mh-actions">
        <button class="mh-btn pa-edit" type="button" aria-label="Edit round ${a.round_number}" title="Edit">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="mh-btn mh-del pa-del" type="button" aria-label="Delete round ${a.round_number}" title="Delete">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </span>
    </div>
    <div class="mh-track"><div class="mh-fill" style="width:${pct}%; background:${color}"></div></div>
    ${tagsHtml ? `<div class="pa-tags-row">${tagsHtml}</div>` : ''}
  </div>`;
}

/** Mini line chart of marks across logged rounds — same visual language as the model-paper marks chart. */
function renderMiniChart(year, attempts) {
  miniChart?.destroy(); miniChart = null;
  const canvas = $(`pa-chart-${year}`);
  if (!canvas) return;
  const box = canvas.closest('.chart-box');
  const scored = [...attempts].filter(a => a.marks !== null).sort((a, b) => a.round_number - b.round_number);
  if (!scored.length) { box.style.display = 'none'; return; }
  box.style.display = 'block';

  const c = chartColors();
  const ctx = canvas.getContext('2d');
  miniChart = new Chart(ctx, {
    type: 'line',
    data: { labels: scored.map(a => `R${a.round_number}`), datasets: [{
      data: scored.map(a => +a.marks),
      borderColor: SUBJECT_COLORS[activePaperSubject] || '#2AABEE', backgroundColor: 'transparent',
      tension: .42, cubicInterpolationMode: 'monotone', borderWidth: 2.5,
      pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: scored.map(a => gradeHex(+a.marks)),
      pointBorderColor: c.cardBg, pointBorderWidth: 2,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      scales: { x: { ticks: { color: c.text }, grid: { display: false } },
                y: { min: 0, max: 100, ticks: { color: c.text }, grid: { color: c.grid, borderDash: [4, 4] } } },
      plugins: { legend: { display: false } },
    },
  });
}

/** Wires the "Add attempt" button and history edit/delete for one expanded card. */
function wireExpandedCardEvents(year) {
  const region = $(`pc-expand-${year}`);
  if (!region) return;

  region.querySelector(`#pa-add-attempt-${year}`).onclick = () => openAttemptSheet(year);

  region.querySelector('.pa-history').addEventListener('click', e => {
    const editBtn = e.target.closest('.pa-edit');
    const delBtn = e.target.closest('.pa-del');
    if (editBtn) {
      const round = +editBtn.closest('.mh-bubble').dataset.round;
      openAttemptSheet(year, round);           // edit mode in the sheet
    } else if (delBtn) {
      if (delBtn.dataset.armed === '1') deletePaperAttempt(year, +delBtn.closest('.mh-bubble').dataset.round);
      else armDeleteBtn(delBtn); // two-tap confirm, same helper the marks history uses
    }
  });
}

async function saveAttempt(year, roundNumber, marks, timeTaken, tags) {
  const body = {
    user_id: me.telegram_id, subject: activePaperSubject, year, round_number: roundNumber,
    marks, time_taken_minutes: timeTaken, weak_tags: tags,
  };
  const { error } = await db.from('paper_attempts').upsert(body, { onConflict: 'user_id,subject,year,round_number' });
  if (error) { toast('Save failed 😕'); return false; }
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

/** Re-fetches one year's attempts and redraws its history + chart in place. */
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

/* ---------------- Paper attempt sheet (Add attempt / edit round) ---------------- */

/** Next un-logged round number — or the 5th round to re-edit when all are done. */
function nextAttemptRound(attempts) {
  return attempts.length < 5 ? attempts.length + 1 : 5;
}

/**
 * Opens the attempt sheet for one paper year.
 *  - no roundNumber: "log" mode, targeting the next un-logged round
 *  - roundNumber:    "edit" mode, fields prefilled from that attempt
 */
function openAttemptSheet(year, roundNumber = null) {
  attemptEntryYear = year;
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

  $('attempt-sheet').hidden = false;
}

function closeAttemptSheet() { $('attempt-sheet').hidden = true; }

async function saveAttemptEntry() {
  const marks = parseFloat($('attempt-marks').value);
  const timeRaw = $('attempt-time').value.trim();
  const timeTaken = timeRaw === '' ? null : parseInt(timeRaw, 10);

  if (isNaN(marks) || marks < 0 || marks > 100) { toast('Enter marks between 0 and 100'); return; }
  if (timeRaw !== '' && (isNaN(timeTaken) || timeTaken < 0)) { toast('Enter a valid time in minutes'); return; }

  const btn = $('attempt-save');
  setBtnLoading(btn, true, 'Saving…');
  try {
    const ok = await saveAttempt(attemptEntryYear, attemptEntryRound, marks, timeTaken, [...selectedWeakTags]);
    if (!ok) return;
    toast(`Round ${attemptEntryRound} saved ✅`);
    closeAttemptSheet();
    await refreshPaperCardAttempts(attemptEntryYear);
    await loadWeakTagsData(); // tags may have changed → refresh autocomplete pool + dashboard analytics
  } catch (err) {
    console.error(err);
    toast('Save failed 😕');
  } finally {
    setBtnLoading(btn, false);
  }
}

/* ---------------- Weak-unit tag input (attempt sheet): autocomplete + chips ---------------- */

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
  // Delay hiding on blur so a click on a dropdown option registers before it disappears.
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

/* ---------------- Weak areas analysis (dashboard panel) ---------------- */

/** One query covers both the autocomplete pool (all unique tags) and the ranked frequency list. */
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
  $('ai-mentor-close')?.addEventListener('click', hideAIMentorCard);
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
    if (dot) { handlePaperDotClick(dot); return; }
    if (e.target.closest('.pc-expand')) return; // clicks inside the expanded form shouldn't collapse the card
    const card = e.target.closest('.paper-card');
    if (card) togglePaperCard(card, +card.dataset.year);
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
  $('growth-log-today').onclick = () => openLogSheet(sltDate());
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
  $('paper-type-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    $('paper-type-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
  });

  // NEW: marks history edit/delete via event delegation — works the same now
  // that #marks-history lives inside its bottom sheet (same node, just moved).
  $('marks-history')?.addEventListener('click', handleMarksHistoryClick);

  // List bottom sheets — "View activity" pill (donut panel) + history icon
  // (marks panel header). Backdrop taps close, same as the entry sheets.
  $('btn-view-activity').onclick = openActivitySheet;
  $('activity-close').onclick = closeActivitySheet;
  $('activity-sheet').addEventListener('click', e => { if (e.target === $('activity-sheet')) closeActivitySheet(); });

  $('btn-marks-history').onclick = openMarksHistorySheet;
  $('marks-history-close').onclick = closeMarksHistorySheet;
  $('marks-history-sheet').addEventListener('click', e => { if (e.target === $('marks-history-sheet')) closeMarksHistorySheet(); });

  // Paper-attempt sheet (Papers tab → "+ Add attempt" / history edit icon)
  $('attempt-cancel').onclick = closeAttemptSheet;
  $('attempt-close').onclick = closeAttemptSheet;
  $('attempt-sheet').addEventListener('click', e => { if (e.target === $('attempt-sheet')) closeAttemptSheet(); });
  $('attempt-save').onclick = saveAttemptEntry;
  wireAttemptTagInput();

  // Real-time totals — per-subject rows → "hours total" stepper display.
  // Delegated on the container because the rows are rebuilt on every openLogSheet().
  // (The stepper +/- still works for manual totals with no subject split —
  // typing in any subject row simply re-syncs the total to the row sum.)
  $('log-subject-rows').addEventListener('input', e => {
    if (!e.target.closest('.subject-row')) return;
    let sum = 0;
    $('log-subject-rows').querySelectorAll('.subject-row input').forEach(inp => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) sum += v;                 // empty / invalid rows count as 0
    });
    logHours = +sum.toFixed(1);
    $('log-hours-display').textContent = logHours;
  });

  // Real-time totals — Essay + MCQ → "Total marks" field.
  // Empty/NaN fields count as 0; when BOTH are empty the total is left as-is
  // so logging a total without a breakdown stays possible.
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

/* ================= AI Mentor (Gemini-powered daily insight) ================= */

let mentorTypeTimer = null;

/**
 * Once a day, ask the worker's /api/mentor endpoint for a short AI insight
 * and show it in the glassmorphism popup. No-ops on repeat calls the same day.
 */
async function checkAndShowAIMentor() {
  try {
    if (!me || !CONFIG.WORKER_URL) return;

    const today = sltDate();
    const storageKey = `alt_lastAIPopupDate_${me.telegram_id}`;
    if (localStorage.getItem(storageKey) === today) return; // already shown today

    const token = localStorage.getItem('alt_token');
    if (!token) return;

    const res = await fetch(`${CONFIG.WORKER_URL}/api/mentor`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`mentor request failed: ${res.status}`);

    const { message } = await res.json();
    if (!message) return;

    localStorage.setItem(storageKey, today); // mark as shown regardless — avoid retry storms
    showAIMentorCard(message);
  } catch (err) {
    console.warn('AI mentor unavailable:', err); // silent failure — never interrupts the dashboard
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
  setTimeout(() => { card.hidden = true; }, 400); // match CSS transition duration
}

/** Reveal `text` inside `el` one character at a time. Calls onDone() when finished. */
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
