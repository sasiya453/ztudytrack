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
const SUBJECT_COLORS = {
  'Combined Maths': '#2AABEE',
  'Bio':            '#3FC65A',
  'Physics':        '#F5A623',
  'Chemistry':      '#9B6BFF',
};
const STATUS_CYCLE = [
  { status: 'not done',  attempt: 0, label: '' },
  { status: '1st time',  attempt: 1, label: '1st' },
  { status: '2nd time+', attempt: 2, label: '2nd+' },
];
const STATUS_CLASS = { 'not done': 'st-not-done', '1st time': 'st-first', '2nd time+': 'st-second' };
const SETTINGS_COLUMNS = {
  'Combined Maths': 'maths_class_day', 'Bio': 'maths_class_day',
  'Physics': 'physics_class_day', 'Chemistry': 'chemistry_class_day',
};

let db = null, me = null, settings = null;
let activePaperSubject = null, activeMarksSubject = null, activeLbPeriod = 'yesterday', activeRange = 14;
let growthChart = null, donutChart = null, marksChart = null;
let editingDate = null, logHours = 0;

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
window.addEventListener('DOMContentLoaded', boot);

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
  const N = activeRange;
  const labels = [], values = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = sltDate(new Date(Date.now() - i * DAY_MS));
    labels.push(d.slice(5));
    values.push(byDate.get(d) || 0);
  }
  const cumulative = []; let run = 0;
  for (const v of values) { run += v; cumulative.push(+run.toFixed(1)); }

  const today = values[values.length - 1];
  const last7 = values.slice(-7).reduce((a, b) => a + b, 0);
  $('stat-today').innerHTML = `${today}<span class="unit">h</span>`;
  $('stat-week').innerHTML  = `${last7.toFixed(1)}<span class="unit">h</span>`;
  $('stat-avg').innerHTML   = `${(last7 / 7).toFixed(1)}<span class="unit">h</span>`;

  // streak: consecutive days with hours > 0, counting back from today (or yesterday if today unlogged)
  const dOrder = [];
  for (let i = 0; i <= 29; i++) dOrder.push(byDate.get(sltDate(new Date(Date.now() - i * DAY_MS))) || 0);
  let start = 0;
  if (dOrder[0] === 0 && dOrder[1] === 0) start = 1;
  let streak = 0;
  for (let i = start; i < dOrder.length && dOrder[i] > 0; i++) streak++;
  $('stat-streak').innerHTML = `${streak}<span class="unit">🔥</span>`;

  renderGrowthChart(labels, values, cumulative);
}

function chartColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return { grid: dark ? '#22303C' : '#E3E7EC', text: dark ? '#8B98A5' : '#707579' };
}

function renderGrowthChart(labels, daily, cumulative) {
  growthChart?.destroy();
  const ctx = $('growthChart').getContext('2d');
  const c = chartColors();
  const grad = ctx.createLinearGradient(0, 0, 0, 240);
  grad.addColorStop(0, 'rgba(42,171,238,.28)'); grad.addColorStop(1, 'rgba(42,171,238,0)');
  growthChart = new Chart(ctx, {
    data: { labels, datasets: [
      { type: 'bar', label: 'Hours / day', data: daily, backgroundColor: '#2AABEE', borderRadius: 6, yAxisID: 'y', maxBarThickness: 22 },
      { type: 'line', label: 'Cumulative (h)', data: cumulative, borderColor: '#3FC65A',
        backgroundColor: grad, fill: true, tension: .35, pointRadius: 0, yAxisID: 'y1' },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: c.text }, grid: { display: false } },
        y:  { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid } },
        y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { color: c.text } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: c.text } } },
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
  const entries = Object.entries(totals).filter(([, v]) => v > 0);

  donutChart?.destroy();
  const c = chartColors();
  if (!entries.length) {
    $('donut-legend').innerHTML = '<li class="donut-empty">No per-subject hours logged in the last 30 days yet — split your hours next time you log.</li>';
    $('subjectDonut').style.display = 'none';
    return;
  }
  $('subjectDonut').style.display = 'block';
  const ctx = $('subjectDonut').getContext('2d');
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: entries.map(e => e[0]), datasets: [{ data: entries.map(e => +e[1].toFixed(1)),
      backgroundColor: entries.map(e => SUBJECT_COLORS[e[0]] || '#94a3b8'), borderWidth: 0 }] },
    options: { plugins: { legend: { display: false } }, cutout: '68%' },
  });
  $('donut-legend').innerHTML = entries.sort((a, b) => b[1] - a[1]).map(([name, hrs]) => `
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
  });

  $('log-sheet').hidden = false;
}

function closeLogSheet() { $('log-sheet').hidden = true; }

async function saveLog() {
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
}

function sb_upsertSession(date, subject, hours) {
  return db.from('study_sessions').upsert(
    { user_id: me.telegram_id, session_date: date, subject, study_hours: hours },
    { onConflict: 'user_id,session_date,subject' }
  );
}

async function deleteLog() {
  await db.from('study_sessions').delete().eq('user_id', me.telegram_id).eq('session_date', editingDate);
  closeLogSheet();
  toast('Entry deleted');
  await Promise.all([loadStats(), loadDonut(), loadHeatmap(), loadLogFeed()]);
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
  const currentWeek = sltWeekNumber();
  const fromWeek = Math.max(1, currentWeek - 11);

  const { data } = await db.from('model_papers')
    .select('week_number, marks, is_absent').eq('subject', subject)
    .gte('week_number', fromWeek).lte('week_number', currentWeek).order('week_number');
  const byWeek = new Map((data || []).map(r => [r.week_number, r]));

  // chart: only weeks with real marks
  const chartLabels = [], chartData = [];
  for (let w = fromWeek; w <= currentWeek; w++) {
    const r = byWeek.get(w);
    if (r && !r.is_absent && r.marks !== null) { chartLabels.push(`W${w}`); chartData.push(+r.marks); }
  }
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
    },
  });

  // editable list, most recent week first
  let lastMarks = null;
  const rowsHtml = [];
  for (let w = currentWeek; w >= fromWeek; w--) {
    const r = byWeek.get(w);
    const marks = r && !r.is_absent && r.marks !== null ? +r.marks : '';
    const isAbsent = !!(r && r.is_absent);
    rowsHtml.push({ w, marks, isAbsent });
  }
  // compute diff vs previous *entered* week, walking chronologically
  const diffByWeek = {};
  let prev = null;
  for (let w = fromWeek; w <= currentWeek; w++) {
    const r = byWeek.get(w);
    if (r && !r.is_absent && r.marks !== null) {
      if (prev !== null) diffByWeek[w] = +r.marks - prev;
      prev = +r.marks;
    }
  }

  $('marks-edit-list').innerHTML = rowsHtml.map(({ w, marks, isAbsent }) => {
    const diff = diffByWeek[w];
    const diffHtml = diff === undefined ? '' :
      `<span class="mr-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff > 0 ? '+' : ''}${diff.toFixed(1)}</span>`;
    return `<div class="marks-row" data-week="${w}">
      <span class="mr-week">Week ${w}</span>
      <input type="number" min="0" max="100" step="0.5" value="${marks}" ${isAbsent ? 'disabled' : ''} placeholder="—" />
      ${diffHtml}
      <button class="mr-absent-chip ${isAbsent ? 'active' : ''}" data-week="${w}">Absent</button>
    </div>`;
  }).join('');

  $('marks-edit-list').querySelectorAll('input').forEach(inp => {
    inp.onchange = () => saveMarks(subject, +inp.closest('.marks-row').dataset.week, parseFloat(inp.value), false);
  });
  $('marks-edit-list').querySelectorAll('.mr-absent-chip').forEach(btn => {
    btn.onclick = () => {
      const nowAbsent = !btn.classList.contains('active');
      saveMarks(subject, +btn.dataset.week, null, nowAbsent);
    };
  });
}

async function saveMarks(subject, week, marks, isAbsent) {
  const body = { user_id: me.telegram_id, subject, week_number: week,
    marks: isAbsent ? null : (isNaN(marks) ? null : marks), is_absent: isAbsent };
  const { error } = await db.from('model_papers').upsert(body, { onConflict: 'user_id,subject,week_number' });
  if (error) { toast('Update failed 😕'); return; }
  toast('Marks saved ✅');
  renderMarksPanel();
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
    .select('year, status').eq('subject', activePaperSubject);
  const byYear = new Map((papers || []).map(p => [p.year, p]));
  const doneCount = [...byYear.values()].filter(p => p.status !== 'not done').length;

  $('progress-label').textContent = `${doneCount} / ${totalYears} papers done`;
  $('progress-pct').textContent = `${Math.round((doneCount / totalYears) * 100)}%`;
  $('progress-fill').style.width = `${(doneCount / totalYears) * 100}%`;

  let html = '';
  for (let y = currentYear; y >= 2000; y--) {
    const st = byYear.get(y)?.status || 'not done';
    const idx = STATUS_CYCLE.findIndex(c => c.status === st);
    html += `<div class="paper-cell ${STATUS_CLASS[st]}" data-year="${y}" title="${st}">${y}<small>${STATUS_CYCLE[idx].label}</small></div>`;
  }
  $('paper-grid').innerHTML = html;
}

async function cyclePaper(cell) {
  const year = +cell.dataset.year;
  const current = cell.querySelector('small').textContent;
  const idx = STATUS_CYCLE.findIndex(c => c.label === current);
  const next = STATUS_CYCLE[(idx + 1) % 3];

  cell.className = `paper-cell ${STATUS_CLASS[next.status]}`;
  cell.querySelector('small').textContent = next.label;

  const { error } = await db.from('past_papers').upsert({
    user_id: me.telegram_id, subject: activePaperSubject, year,
    status: next.status, attempt_number: next.attempt,
  }, { onConflict: 'user_id,subject,year' });
  if (error) { toast('Update failed 😕'); renderPaperGrid(); return; }
  renderPaperGrid();
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
      <span class="lb-photo">${r.photo_url ? `<img src="${r.photo_url}" alt="">` : r.name[0].toUpperCase()}</span>
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
    const cell = e.target.closest('.paper-cell');
    if (cell) cyclePaper(cell);
  });

  $('range-toggle').querySelectorAll('.chip').forEach(b => b.onclick = () => {
    activeRange = +b.dataset.range;
    $('range-toggle').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
    loadStats();
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
}

/* ================= utils ================= */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
