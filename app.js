'use strict';

/* ── J: Utilities ─────────────────────────────────────── */

function formatHHMMSS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  if (d > 0) return `${d}d ${rh}h ${String(m).padStart(2, '0')}m`;
  if (h > 0)  return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function formatDateTimeLocal(isoStr) {
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDateTimeLocal(str) {
  return new Date(str).toISOString();
}

function formatShortDate(isoStr) {
  return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function generateId() {
  return String(Date.now());
}

/* ── A: Storage ───────────────────────────────────────── */

const KEYS = { state: 'ft_state', history: 'ft_history', settings: 'ft_settings' };

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.state)) || { status: 'idle', startTime: null, goalHours: null, waterCount: 0 };
  } catch { return { status: 'idle', startTime: null, goalHours: null, waterCount: 0 }; }
}

function saveState(obj) {
  localStorage.setItem(KEYS.state, JSON.stringify(obj));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.history)) || [];
  } catch { return []; }
}

function saveHistory(arr) {
  localStorage.setItem(KEYS.history, JSON.stringify(arr));
}

function loadSettings() {
  const defaults = { darkMode: false, defaultGoalHours: 16 };
  try {
    return Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEYS.settings)));
  } catch { return defaults; }
}

function saveSettingsToStorage(obj) {
  localStorage.setItem(KEYS.settings, JSON.stringify(obj));
}

/* ── B: State machine ─────────────────────────────────── */

let _appState = loadState();
let _prevState = 'idle';

function getAppState() { return _appState; }

function transition(newStatus) {
  _prevState = _appState.status;
  _appState.status = newStatus;
  document.body.dataset.state = newStatus;
  saveState(_appState);
  renderUI();
}

/* ── C: Timer engine ──────────────────────────────────── */

let _tickId = null;
const RING_CIRCUMFERENCE = 2 * Math.PI * 108;

function startTick() {
  if (_tickId) clearInterval(_tickId);
  updateTimerDisplay();
  _tickId = setInterval(updateTimerDisplay, 1000);
}

function stopTick() {
  if (_tickId) { clearInterval(_tickId); _tickId = null; }
}

function updateTimerDisplay() {
  const state = getAppState();
  if (!state.startTime) return;

  const elapsed = Date.now() - new Date(state.startTime).getTime();
  const timerEl = document.getElementById('timer-display');
  if (timerEl) timerEl.textContent = formatHHMMSS(elapsed);

  updateProgress(elapsed);
}

function updateProgress(elapsed) {
  const state = getAppState();
  const ringFill = document.getElementById('ring-fill');
  const progressFill = document.getElementById('progress-bar-fill');
  const timeRemaining = document.getElementById('time-remaining');
  const goalLabel = document.getElementById('goal-label');
  const progressSection = document.getElementById('progress-section');

  const goalMs = state.goalHours ? state.goalHours * 3600 * 1000 : null;
  const pct = goalMs ? Math.min(elapsed / goalMs, 1) : 0;

  if (ringFill) {
    const offset = RING_CIRCUMFERENCE * (1 - pct);
    ringFill.style.strokeDashoffset = String(offset);
  }

  if (progressFill) {
    progressFill.style.width = `${pct * 100}%`;
  }

  if (goalMs) {
    if (progressSection) progressSection.style.display = 'flex';

    const remaining = goalMs - elapsed;
    if (timeRemaining) {
      if (remaining > 0) {
        timeRemaining.textContent = formatDuration(remaining) + ' left';
      } else {
        timeRemaining.textContent = 'Goal reached!';
        timeRemaining.style.color = 'var(--accent-idle)';
      }
    }

    if (goalLabel) {
      if (remaining > 0) {
        goalLabel.textContent = `${state.goalHours}h goal · ${formatDuration(remaining)} left`;
      } else {
        goalLabel.textContent = `${state.goalHours}h goal · Fasting complete!`;
      }
    }
  } else {
    if (progressSection) progressSection.style.display = 'none';
    if (goalLabel) goalLabel.textContent = 'Fasting…';
  }
}

/* ── N: Notifications ─────────────────────────────────── */

let _notifTimeouts = [];

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function showNotif(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: './icons/icon-512.png', badge: './icons/icon-192.png', tag };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification(title, opts));
  } else {
    new Notification(title, opts);
  }
}

function clearScheduledNotifications() {
  _notifTimeouts.forEach(id => clearTimeout(id));
  _notifTimeouts = [];
}

function scheduleNotifications(startTimeISO, goalHours) {
  clearScheduledNotifications();
  if (!goalHours) return;

  const startMs = new Date(startTimeISO).getTime();
  const goalMs  = goalHours * 3600 * 1000;
  const now     = Date.now();

  const schedule = (fireAt, title, body, tag) => {
    const delay = fireAt - now;
    if (delay <= 0) return;
    _notifTimeouts.push(setTimeout(() => showNotif(title, body, tag), delay));
  };

  // 1 hour after start
  schedule(
    startMs + 3600000,
    'Fast started',
    `1 hour in — keep it up! ${goalHours}h goal ahead.`,
    'ft-1h-start'
  );

  // Halfway through
  schedule(
    startMs + goalMs / 2,
    'Halfway there!',
    `You're halfway through your ${goalHours}h fast. Stay strong!`,
    'ft-halfway'
  );

  // 1 hour before goal
  schedule(
    startMs + goalMs - 3600000,
    'Almost done!',
    `Only 1 hour left in your ${goalHours}h fast!`,
    'ft-1h-end'
  );

  // Goal reached
  schedule(
    startMs + goalMs,
    'Fast complete!',
    `You've completed your ${goalHours}h fast! Time to break the fast.`,
    'ft-goal'
  );

  // 12:00 PM notification — next noon that falls inside the fast window
  const fastEndMs = startMs + goalMs;
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  if (noon.getTime() <= now) noon.setDate(noon.getDate() + 1);
  if (noon.getTime() < fastEndMs) {
    const remaining = fastEndMs - noon.getTime();
    schedule(
      noon.getTime(),
      'Midday check-in',
      `${formatDuration(remaining)} left in your fast. Keep going!`,
      'ft-noon'
    );
  }
}

/* ── D: Fast controls ─────────────────────────────────── */

let _undoTimeout = null;
let _pendingEndState = null;

function handleStartFast() {
  const settings = loadSettings();
  const goalHours = settings.defaultGoalHours || null;

  _appState = {
    status: 'fasting',
    startTime: new Date().toISOString(),
    goalHours,
    waterCount: 0,
  };
  saveState(_appState);
  transition('fasting');
  startTick();

  requestNotificationPermission().then(granted => {
    if (granted) scheduleNotifications(_appState.startTime, _appState.goalHours);
  });
}

function handleEndFast() {
  stopTick();
  _pendingEndState = Object.assign({}, _appState);
  transition('confirming');
  showSnackbar('Fast ended', commitEndFast, undoEndFast);
}

function commitEndFast() {
  clearScheduledNotifications();
  if (!_pendingEndState) { transition('idle'); return; }

  const endTime = new Date().toISOString();
  const startTime = _pendingEndState.startTime;
  const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
  const goalMs = _pendingEndState.goalHours ? _pendingEndState.goalHours * 3600 * 1000 : null;

  const entry = {
    id: generateId(),
    startTime,
    endTime,
    durationMs,
    goalHours: _pendingEndState.goalHours || null,
    goalMet: goalMs ? durationMs >= goalMs : null,
    waterCount: _pendingEndState.waterCount || 0,
    note: '',
  };

  const history = loadHistory();
  history.unshift(entry);
  saveHistory(history);

  _appState = { status: 'idle', startTime: null, goalHours: null, waterCount: 0 };
  saveState(_appState);
  _pendingEndState = null;

  transition('idle');
  renderHistory();
}

function undoEndFast() {
  if (_undoTimeout) { clearTimeout(_undoTimeout); _undoTimeout = null; }
  _appState = Object.assign({}, _pendingEndState, { status: 'fasting' });
  _pendingEndState = null;
  saveState(_appState);
  transition('fasting');
  startTick();
  requestNotificationPermission().then(granted => {
    if (granted) scheduleNotifications(_appState.startTime, _appState.goalHours);
  });
}

/* ── E: Water tracking ────────────────────────────────── */

function handleAddWater() {
  _appState.waterCount = (_appState.waterCount || 0) + 1;
  saveState(_appState);
  const el = document.getElementById('water-count');
  if (el) {
    el.textContent = String(_appState.waterCount);
    el.animate([{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
  }
}

/* ── F: Edit modal ────────────────────────────────────── */

let _editingId = null;

function openEditModal(idOrLive) {
  _editingId = idOrLive;
  const modal = document.getElementById('edit-modal');
  const endGroup = document.getElementById('edit-end-group');
  const title = document.getElementById('edit-modal-title');

  if (idOrLive === 'live') {
    const state = getAppState();
    document.getElementById('edit-start').value = formatDateTimeLocal(state.startTime);
    document.getElementById('edit-goal').value = state.goalHours || '';
    document.getElementById('edit-water').value = state.waterCount || 0;
    if (endGroup) endGroup.style.display = 'none';
    if (title) title.textContent = 'Edit Current Fast';
  } else {
    const history = loadHistory();
    const entry = history.find(e => e.id === idOrLive);
    if (!entry) return;
    document.getElementById('edit-start').value = formatDateTimeLocal(entry.startTime);
    document.getElementById('edit-end').value   = formatDateTimeLocal(entry.endTime);
    document.getElementById('edit-goal').value  = entry.goalHours || '';
    document.getElementById('edit-water').value = entry.waterCount || 0;
    if (endGroup) endGroup.style.display = '';
    if (title) title.textContent = 'Edit Fast';
  }

  modal.hidden = false;
}

function saveEditModal() {
  const startVal = document.getElementById('edit-start').value;
  const endVal   = document.getElementById('edit-end').value;
  const goalVal  = parseInt(document.getElementById('edit-goal').value, 10) || null;
  const waterVal = parseInt(document.getElementById('edit-water').value, 10) || 0;

  if (!startVal) return;

  if (_editingId === 'live') {
    _appState.startTime = parseDateTimeLocal(startVal);
    _appState.goalHours = goalVal;
    _appState.waterCount = waterVal;
    saveState(_appState);
    const el = document.getElementById('water-count');
    if (el) el.textContent = String(waterVal);
  } else {
    const history = loadHistory();
    const idx = history.findIndex(e => e.id === _editingId);
    if (idx === -1) return;

    const entry = history[idx];
    entry.startTime = parseDateTimeLocal(startVal);
    if (endVal) entry.endTime = parseDateTimeLocal(endVal);
    entry.goalHours = goalVal;
    entry.waterCount = waterVal;
    entry.durationMs = new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime();
    entry.goalMet = entry.goalHours
      ? entry.durationMs >= entry.goalHours * 3600 * 1000
      : null;

    history[idx] = entry;
    saveHistory(history);
    renderHistory();
  }

  closeEditModal();
}

function closeEditModal() {
  document.getElementById('edit-modal').hidden = true;
  _editingId = null;
}

/* ── G: History rendering ─────────────────────────────── */

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;

  const history = loadHistory();
  list.innerHTML = '';

  if (history.length === 0) {
    list.innerHTML = '<div class="history-empty">No fasts recorded yet</div>';
    return;
  }

  history.forEach(entry => {
    list.appendChild(createHistoryRow(entry));
  });
}

function createHistoryRow(entry) {
  const row = document.createElement('div');
  row.className = 'history-row';
  row.dataset.id = entry.id;

  const goalMet = entry.goalMet;
  const badgeHtml = goalMet === true
    ? '<span class="badge badge--met">✓ Goal met</span>'
    : goalMet === false
    ? '<span class="badge badge--missed">Goal missed</span>'
    : '';

  const waterHtml = entry.waterCount > 0
    ? `<span class="water-badge">💧 ${entry.waterCount}</span>`
    : '';

  const endTimeDisplay = entry.endTime ? formatTime(entry.endTime) : '—';

  row.innerHTML = `
    <div class="history-row-date">${formatShortDate(entry.startTime)}</div>
    <div class="history-row-duration">${formatDuration(entry.durationMs)}</div>
    <div class="history-row-meta">
      <span>${formatTime(entry.startTime)} → ${endTimeDisplay}</span>
      ${waterHtml}
    </div>
    <div class="history-row-actions">
      ${badgeHtml}
      <button class="history-edit-btn" data-id="${entry.id}" aria-label="Edit this fast">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    </div>
  `;

  row.querySelector('.history-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    openEditModal(entry.id);
  });

  return row;
}

/* ── H: Settings ──────────────────────────────────────── */

function openSettings() {
  const settings = loadSettings();
  document.getElementById('settings-goal').value = settings.defaultGoalHours || '';
  document.getElementById('settings-dark').checked = settings.darkMode;
  document.getElementById('settings-modal').hidden = false;
}

function saveAndCloseSettings() {
  const goalVal = parseInt(document.getElementById('settings-goal').value, 10) || 16;
  const dark    = document.getElementById('settings-dark').checked;

  const settings = { darkMode: dark, defaultGoalHours: goalVal };
  saveSettingsToStorage(settings);
  applyDarkMode(dark);
  document.getElementById('settings-modal').hidden = true;
}

function applyDarkMode(enabled) {
  document.documentElement.classList.toggle('dark', enabled);
}

/* ── Snackbar helper ──────────────────────────────────── */

let _snackTimeout = null;

function showSnackbar(text, onConfirm, onUndo) {
  const bar = document.getElementById('snackbar');
  const textEl = document.getElementById('snackbar-text');
  const undoBtn = document.getElementById('snackbar-undo');

  textEl.textContent = text;
  bar.classList.add('visible');

  if (_snackTimeout) clearTimeout(_snackTimeout);

  const dismiss = () => {
    bar.classList.remove('visible');
    undoBtn.onclick = null;
  };

  undoBtn.onclick = () => {
    clearTimeout(_snackTimeout);
    dismiss();
    if (onUndo) onUndo();
  };

  _snackTimeout = setTimeout(() => {
    dismiss();
    if (onConfirm) onConfirm();
  }, 3500);
}

/* ── UI render ────────────────────────────────────────── */

function renderUI() {
  const state = getAppState();

  const btnLabel = document.getElementById('btn-label');
  const waterCount = document.getElementById('water-count');

  if (btnLabel) {
    btnLabel.textContent = state.status === 'idle' ? 'Start Fast' : 'End Fast';
  }

  if (waterCount) {
    waterCount.textContent = String(state.waterCount || 0);
  }

  if (state.status === 'idle') {
    const timerEl = document.getElementById('timer-display');
    if (timerEl) timerEl.textContent = '00:00:00';
    const goalLabel = document.getElementById('goal-label');
    if (goalLabel) goalLabel.textContent = 'Tap to start fasting';
    const ringFill = document.getElementById('ring-fill');
    if (ringFill) ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    const progressFill = document.getElementById('progress-bar-fill');
    if (progressFill) progressFill.style.width = '0%';
  }
}

/* ── I: Init & bindings ───────────────────────────────── */

function bindEvents() {
  document.getElementById('start-stop-btn').addEventListener('click', () => {
    const status = getAppState().status;
    if (status === 'idle') handleStartFast();
    else if (status === 'fasting') handleEndFast();
  });

  document.getElementById('water-btn').addEventListener('click', handleAddWater);

  document.getElementById('edit-live-btn').addEventListener('click', () => openEditModal('live'));

  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('dark-toggle').addEventListener('click', () => {
    const settings = loadSettings();
    settings.darkMode = !settings.darkMode;
    saveSettingsToStorage(settings);
    applyDarkMode(settings.darkMode);
    if (document.getElementById('settings-dark')) {
      document.getElementById('settings-dark').checked = settings.darkMode;
    }
  });

  document.getElementById('edit-save').addEventListener('click', saveEditModal);
  document.getElementById('edit-cancel').addEventListener('click', closeEditModal);
  document.getElementById('edit-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeEditModal();
  });

  document.getElementById('settings-close').addEventListener('click', saveAndCloseSettings);
  document.getElementById('settings-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) saveAndCloseSettings();
  });

  document.getElementById('settings-dark').addEventListener('change', e => {
    applyDarkMode(e.target.checked);
  });

  document.getElementById('clear-history-btn').addEventListener('click', () => {
    if (loadHistory().length === 0) return;
    saveHistory([]);
    renderHistory();
  });
}

function initApp() {
  const settings = loadSettings();
  applyDarkMode(settings.darkMode);

  _appState = loadState();
  document.body.dataset.state = _appState.status;

  renderUI();
  renderHistory();

  if (_appState.status === 'fasting') {
    startTick();
    requestNotificationPermission().then(granted => {
      if (granted) scheduleNotifications(_appState.startTime, _appState.goalHours);
    });
  }

  bindEvents();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', initApp);
