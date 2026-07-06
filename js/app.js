import { loadConfig, saveConfig, clearConfig, encodeSetupCode, decodeSetupCode } from './config.js';
import { readItem, updateItem } from './dynamo.js';
import { splitDayNight, formatElapsed, formatMinutes, formatHoursDecimal, uid, formatDate, formatTime } from './utils.js';
import { printLog, downloadBackup, parseBackup } from './export.js';
import { getCutoffsForDate, hasSunConfig } from './sun.js';

const APP_VERSION = 'v8';

let config = loadConfig();
let currentItem = null;
let tickHandle = null;
let pollHandle = null;
let editingSessionId = null; // set when the entry modal is editing rather than adding
let editingOriginalStart = null;
let editingOriginalEnd = null;
let swRegistration = null;
let isRefreshingForUpdate = false;
let isStopping = false;
let latestPublishedVersion = APP_VERSION;

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

if (config) {
  showApp();
  boot();
} else {
  showSetupGate();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      swRegistration = registration;
      wireUpdatePrompt(registration);
    })
    .catch(() => {
      /* offline shell just won't be available — not fatal */
    });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isRefreshingForUpdate) return;
    isRefreshingForUpdate = true;
    location.reload();
  });
}

function wireUpdatePrompt(registration) {
  if (registration.waiting) showUpdateBanner();

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showUpdateBanner();
      }
    });
  });
}

function showUpdateBanner(message = 'A new version is ready.', actionText = 'Refresh', actionHandler = null) {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const btn = document.getElementById('update-now-btn');
  if (!banner || !btn) return;

  banner.classList.remove('hidden');
  if (text) text.textContent = message;
  setVersionBadge(`${APP_VERSION} update ready`, true);
  btn.disabled = false;
  btn.textContent = actionText;

  if (actionHandler) {
    btn.onclick = actionHandler;
    return;
  }

  btn.onclick = () => {
    const waiting = swRegistration?.waiting;
    btn.disabled = true;
    btn.textContent = 'Updating...';
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    location.reload();
  };
}

async function boot() {
  document.getElementById('driver-name-label').textContent = config.driver;
  wireVersionBadgeCheck();
  await updateVersionBadge();
  await refresh();
  startPolling();
  startTicking();
  wireAppEvents();
}

function setVersionBadge(text, isOutdated = false) {
  const el = document.getElementById('app-version');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('outdated', isOutdated);
}

async function updateVersionBadge() {
  let isOutdated = false;
  let latest = APP_VERSION;
  setVersionBadge(`${APP_VERSION} current`, false);

  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { latest, isOutdated };
    const payload = await res.json();
    latest = String(payload?.version || '').trim();
    if (!latest) return { latest: APP_VERSION, isOutdated };
    latestPublishedVersion = latest;

    if (latest !== APP_VERSION) {
      isOutdated = true;
      setVersionBadge(`${APP_VERSION} -> ${latest}`, true);
      if (!swRegistration?.waiting) {
        showUpdateBanner(
          `Release ${latest} published. Tap Check now to request the new service worker.`,
          'Check now',
          checkForUpdatesFromBadge
        );
      }
    }
  } catch {
    // Version check is informational only.
  }

  return { latest, isOutdated };
}

function wireVersionBadgeCheck() {
  const badge = document.getElementById('app-version');
  if (!badge) return;

  badge.title = 'Tap to check for updates';
  badge.onclick = checkForUpdatesFromBadge;
}

async function checkForUpdatesFromBadge() {
  const badge = document.getElementById('app-version');
  if (!badge) return;
  if (badge.dataset.checking === '1') return;
  badge.dataset.checking = '1';
  setVersionBadge('Checking...', false);

  try {
    await swRegistration?.update();
    if (swRegistration?.waiting) {
      showUpdateBanner();
      return;
    }

    const status = await updateVersionBadge();
    if (!status.isOutdated) {
      setVersionBadge(`${APP_VERSION} current`, false);
      return;
    }

    showUpdateBanner(
      `Still on ${APP_VERSION}. Latest is ${latestPublishedVersion}.`,
      'Reload',
      () => location.reload()
    );
  } finally {
    badge.dataset.checking = '0';
  }
}

// ---------------------------------------------------------------------
// Setup gate
// ---------------------------------------------------------------------

function showSetupGate() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  wireSetupEvents();
}

function showApp() {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function wireSetupEvents() {
  const pasteBox = document.getElementById('setup-paste');
  const advBox = document.getElementById('setup-advanced');

  document.getElementById('show-advanced').addEventListener('click', () => {
    pasteBox.classList.add('hidden');
    advBox.classList.remove('hidden');
  });
  document.getElementById('show-paste').addEventListener('click', () => {
    advBox.classList.add('hidden');
    pasteBox.classList.remove('hidden');
  });

  document.getElementById('setup-code-submit').addEventListener('click', () => {
    const errEl = document.getElementById('setup-error');
    errEl.classList.add('hidden');
    const raw = document.getElementById('setup-code-input').value;
    try {
      const decoded = decodeSetupCode(raw);
      saveConfig(decoded);
      config = decoded;
      showApp();
      boot();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('setup-advanced-submit').addEventListener('click', () => {
    const errEl = document.getElementById('setup-advanced-error');
    errEl.classList.add('hidden');
    const region = document.getElementById('adv-region').value.trim();
    const idp = document.getElementById('adv-idp').value.trim();
    const table = document.getElementById('adv-table').value.trim();
    const driver = document.getElementById('adv-driver').value.trim();
    if (!region || !idp || !table || !driver) {
      errEl.textContent = 'All fields are required.';
      errEl.classList.remove('hidden');
      return;
    }
    const decoded = { region, idp, table, driver };
    saveConfig(decoded);
    config = decoded;
    showApp();
    boot();
  });
}

// ---------------------------------------------------------------------
// Data refresh / polling
// ---------------------------------------------------------------------

async function refresh() {
  try {
    currentItem = await readItem(config);
    setSyncStatus(true);
    renderAll();
  } catch (err) {
    console.error('Refresh failed', err);
    setSyncStatus(false);
  }
}

function setSyncStatus(ok) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  dot.classList.toggle('offline', !ok);
  dot.title = ok ? 'Synced' : 'Connection trouble';
}

function startPolling() {
  if (pollHandle) clearInterval(pollHandle);
  // Picks up a drive started on another device, or edits made elsewhere.
  pollHandle = setInterval(refresh, 6000);
}

function startTicking() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    if (currentItem && currentItem.active && !isStopping) {
      updateTimerDisplay();
    }
  }, 1000);
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderAll() {
  if (!currentItem) return;
  renderHome();
  renderProgress();
  renderLog();
  renderSettingsForm();
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-display');
  if (currentItem.active) {
    const elapsed = Date.now() - new Date(currentItem.active.startedAt).getTime();
    el.textContent = formatElapsed(elapsed);
  } else {
    el.textContent = '00:00:00';
  }
}

function renderHome() {
  const btn = document.getElementById('start-stop-btn');
  const status = document.getElementById('timer-status');
  updateTimerDisplay();
  if (currentItem.active) {
    btn.textContent = 'Stop Drive';
    btn.classList.remove('btn-start');
    btn.classList.add('btn-stop');
    status.textContent = 'Drive in progress';
  } else {
    btn.textContent = 'Start Drive';
    btn.classList.remove('btn-stop');
    btn.classList.add('btn-start');
    status.textContent = 'Ready to drive';
  }
}

function renderProgress() {
  const totals = computeTotals(currentItem.sessions);
  const { goalTotalHours, goalNightHours } = currentItem.settings;
  const goalTotalMin = goalTotalHours * 60;

  document.getElementById('gauge-total-hours').textContent = formatHoursDecimal(totals.totalMinutes);
  document.getElementById('gauge-goal-hours').textContent = goalTotalHours;
  document.getElementById('day-hours-value').textContent =
    `${formatHoursDecimal(totals.dayMinutes)} / ${goalTotalHours - goalNightHours >= 0 ? goalTotalHours - goalNightHours : goalTotalHours} hrs`;
  document.getElementById('night-hours-value').textContent =
    `${formatHoursDecimal(totals.nightMinutes)} / ${goalNightHours} hrs`;

  const r = 92;
  const circumference = 2 * Math.PI * r;
  const dayFrac = goalTotalMin > 0 ? Math.min(totals.dayMinutes / goalTotalMin, 1) : 0;
  const nightFrac = goalTotalMin > 0 ? Math.min(totals.nightMinutes / goalTotalMin, 1 - dayFrac) : 0;

  const dayEl = document.getElementById('gauge-day');
  const nightEl = document.getElementById('gauge-night');

  dayEl.style.strokeDasharray = `${circumference * dayFrac} ${circumference}`;
  dayEl.style.strokeDashoffset = '0';

  nightEl.style.strokeDasharray = `${circumference * nightFrac} ${circumference}`;
  nightEl.style.strokeDashoffset = `${-circumference * dayFrac}`;
}

function computeTotals(sessions) {
  let dayMinutes = 0;
  let nightMinutes = 0;
  for (const s of sessions) {
    dayMinutes += s.dayMinutes || 0;
    nightMinutes += s.nightMinutes || 0;
  }
  return { dayMinutes, nightMinutes, totalMinutes: dayMinutes + nightMinutes };
}

function renderLog() {
  const list = document.getElementById('log-list');
  const sessions = [...currentItem.sessions].sort((a, b) => new Date(b.start) - new Date(a.start));

  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-state">No drives logged yet. Start one, or add a past entry.</div>';
    return;
  }

  list.innerHTML = sessions
    .map((s) => {
      const total = s.dayMinutes + s.nightMinutes;
      const dayPct = total > 0 ? (s.dayMinutes / total) * 100 : 0;
      const nightPct = 100 - dayPct;
      return `
        <div class="log-row" data-id="${s.id}">
          <div class="log-row-top">
            <span class="log-row-date">${formatDate(s.start)}</span>
            <span class="log-row-duration">${formatMinutes(total)}</span>
          </div>
          <div class="log-row-duration">${formatTime(s.start)} &ndash; ${formatTime(s.end)}</div>
          <div class="log-split-bar">
            <div class="log-split-day" style="width:${dayPct}%"></div>
            <div class="log-split-night" style="width:${nightPct}%"></div>
          </div>
          ${s.note ? `<div class="log-row-note">${escapeHtml(s.note)}</div>` : ''}
          ${s.source === 'manual' ? '<span class="log-row-tag">Manually added</span>' : ''}
        </div>`;
    })
    .join('');

  list.querySelectorAll('.log-row').forEach((row) => {
    row.addEventListener('click', () => openEntryModal(row.dataset.id));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderSettingsForm() {
  const s = normalizedSettings(currentItem.settings || {});
  document.getElementById('goal-total').value = s.goalTotalHours;
  document.getElementById('goal-night').value = s.goalNightHours;
  document.getElementById('day-start').value = s.dayStartHour;
  document.getElementById('night-start').value = s.nightStartHour;
  document.getElementById('use-astro-sun').checked = !!s.useAstronomicalSun;
  document.getElementById('astro-lat').value = Number.isFinite(s.latitude) ? s.latitude : '';
  document.getElementById('astro-lon').value = Number.isFinite(s.longitude) ? s.longitude : '';
  updateAstroLocationVisibility();
}

function updateAstroLocationVisibility() {
  const useAstro = document.getElementById('use-astro-sun').checked;
  const fields = document.getElementById('astro-location-fields');
  fields.classList.toggle('hidden', !useAstro);
}

function normalizedSettings(settings) {
  return {
    goalTotalHours: Number.isFinite(settings.goalTotalHours) ? settings.goalTotalHours : 50,
    goalNightHours: Number.isFinite(settings.goalNightHours) ? settings.goalNightHours : 10,
    dayStartHour: Number.isFinite(settings.dayStartHour) ? settings.dayStartHour : 6,
    nightStartHour: Number.isFinite(settings.nightStartHour) ? settings.nightStartHour : 20,
    useAstronomicalSun: !!settings.useAstronomicalSun,
    latitude: Number.isFinite(settings.latitude) ? settings.latitude : null,
    longitude: Number.isFinite(settings.longitude) ? settings.longitude : null
  };
}

async function requestCurrentPosition() {
  if (!navigator.geolocation) return null;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 600000
      });
    });
    return {
      latitude: Number(pos.coords.latitude.toFixed(4)),
      longitude: Number(pos.coords.longitude.toFixed(4))
    };
  } catch {
    return null;
  }
}

async function getCalculationSettings(settings) {
  const safe = normalizedSettings(settings || {});
  if (!safe.useAstronomicalSun) return safe;
  const coords = await requestCurrentPosition();
  if (!coords) return safe;
  return {
    ...safe,
    latitude: coords.latitude,
    longitude: coords.longitude
  };
}

function nextMidnight(d) {
  const x = new Date(d.getTime());
  x.setHours(24, 0, 0, 0);
  return x;
}

async function splitDayNightForSession(start, end, settings) {
  const runtimeSettings = await getCalculationSettings(settings);
  if (!hasSunConfig(runtimeSettings)) {
    return splitDayNight(start, end, runtimeSettings.dayStartHour, runtimeSettings.nightStartHour);
  }

  let cur = new Date(start.getTime());
  let dayMinutes = 0;
  let nightMinutes = 0;

  while (cur < end) {
    const dayEnd = nextMidnight(cur);
    const segmentEnd = dayEnd < end ? dayEnd : end;
    const cutoffs = await getCutoffsForDate(cur, runtimeSettings);
    const split = splitDayNight(cur, segmentEnd, cutoffs.dayStartHour, cutoffs.nightStartHour);
    dayMinutes += split.dayMinutes;
    nightMinutes += split.nightMinutes;
    cur = segmentEnd;
  }

  return { dayMinutes, nightMinutes };
}

// ---------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------

function wireTabEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`screen-${tab.dataset.screen}`).classList.remove('hidden');
    });
  });
}

// ---------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------

function wireHomeEvents() {
  document.getElementById('start-stop-btn').addEventListener('click', async () => {
    const btn = document.getElementById('start-stop-btn');
    btn.disabled = true;
    try {
      if (currentItem.active) {
        isStopping = true;
        document.getElementById('timer-status').textContent = 'Stopping\u2026';
        const newSessionId = await stopDrive();
        await refresh();
        openEntryModal(newSessionId);
      } else {
        await startDrive();
        await refresh();
      }
    } catch (err) {
      alert(err.message || 'Something went wrong. Try again.');
    } finally {
      isStopping = false;
      btn.disabled = false;
    }
  });
}

async function startDrive() {
  currentItem = await updateItem(config, (item) => {
    if (item.active) throw new Error('A drive is already in progress on another device.');
    return { ...item, active: { startedAt: new Date().toISOString() } };
  });
}

async function stopDrive() {
  const sessionId = uid();
  currentItem = await updateItem(config, async (item) => {
    if (!item.active) throw new Error('No drive is currently in progress.');
    const start = new Date(item.active.startedAt);
    const end = new Date();
    const { dayMinutes, nightMinutes } = await splitDayNightForSession(start, end, item.settings);
    const session = {
      id: sessionId,
      start: start.toISOString(),
      end: end.toISOString(),
      dayMinutes,
      nightMinutes,
      note: undefined,
      source: 'live'
    };
    return { ...item, active: null, sessions: [...item.sessions, session] };
  });
  return sessionId;
}

// ---------------------------------------------------------------------
// Manual entry / edit modal
// ---------------------------------------------------------------------

function wireEntryModalEvents() {
  document.getElementById('add-entry-btn').addEventListener('click', () => openEntryModal(null));
  document.getElementById('entry-cancel-btn').addEventListener('click', closeEntryModal);

  document.getElementById('mode-times').addEventListener('click', () => setEntryMode('times'));
  document.getElementById('mode-duration').addEventListener('click', () => setEntryMode('duration'));

  document.getElementById('entry-save-btn').addEventListener('click', saveEntry);
  document.getElementById('entry-delete-btn').addEventListener('click', deleteEntry);
}

function setEntryMode(mode) {
  document.getElementById('mode-times').classList.toggle('active', mode === 'times');
  document.getElementById('mode-duration').classList.toggle('active', mode === 'duration');
  document.getElementById('entry-times-fields').classList.toggle('hidden', mode !== 'times');
  document.getElementById('entry-duration-fields').classList.toggle('hidden', mode !== 'duration');
}

function openEntryModal(sessionId) {
  editingSessionId = sessionId;
  const modal = document.getElementById('entry-modal');
  const errEl = document.getElementById('entry-error');
  errEl.classList.add('hidden');
  setEntryMode('times');

  const deleteBtn = document.getElementById('entry-delete-btn');
  const title = document.getElementById('entry-modal-title');

  if (sessionId) {
    const s = currentItem.sessions.find((x) => x.id === sessionId);
    title.textContent = 'Edit Entry';
    deleteBtn.classList.remove('hidden');
    const start = new Date(s.start);
    const end = new Date(s.end);
    editingOriginalStart = start;
    editingOriginalEnd = end;
    document.getElementById('entry-date').value = toDateInputValue(start);
    document.getElementById('entry-start-time').value = toTimeInputValue(start);
    document.getElementById('entry-end-time').value = toTimeInputValue(end);
    document.getElementById('entry-note').value = s.note || '';
  } else {
    title.textContent = 'Add Entry';
    deleteBtn.classList.add('hidden');
    editingOriginalStart = null;
    editingOriginalEnd = null;
    document.getElementById('entry-date').value = toDateInputValue(new Date());
    document.getElementById('entry-start-time').value = '';
    document.getElementById('entry-end-time').value = '';
    document.getElementById('entry-duration').value = '';
    document.getElementById('entry-note').value = '';
  }

  modal.classList.remove('hidden');
}

function closeEntryModal() {
  document.getElementById('entry-modal').classList.add('hidden');
  editingSessionId = null;
  editingOriginalStart = null;
  editingOriginalEnd = null;
}

function toDateInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toTimeInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function saveEntry() {
  const errEl = document.getElementById('entry-error');
  errEl.classList.add('hidden');

  const dateStr = document.getElementById('entry-date').value;
  if (!dateStr) {
    errEl.textContent = 'Pick a date.';
    errEl.classList.remove('hidden');
    return;
  }

  const usingDuration = !document.getElementById('entry-duration-fields').classList.contains('hidden');
  let start, end;

  if (usingDuration) {
    const mins = parseInt(document.getElementById('entry-duration').value, 10);
    const period = document.getElementById('entry-duration-period').value;
    if (!mins || mins <= 0) {
      errEl.textContent = 'Enter a duration in minutes.';
      errEl.classList.remove('hidden');
      return;
    }
    // Anchor the whole block inside the middle of the chosen period so the
    // split logic classifies it correctly without needing exact clock times.
    const anchorHour = period === 'day' ? 13 : 23;
    start = new Date(`${dateStr}T00:00:00`);
    start.setHours(anchorHour, 0, 0, 0);
    end = new Date(start.getTime() + mins * 60000);
  } else {
    const startTime = document.getElementById('entry-start-time').value;
    const endTime = document.getElementById('entry-end-time').value;
    if (!startTime || !endTime) {
      errEl.textContent = 'Enter both a start and end time.';
      errEl.classList.remove('hidden');
      return;
    }

    const fieldsUnchanged =
      editingSessionId &&
      editingOriginalStart &&
      editingOriginalEnd &&
      dateStr === toDateInputValue(editingOriginalStart) &&
      startTime === toTimeInputValue(editingOriginalStart) &&
      endTime === toTimeInputValue(editingOriginalEnd);

    if (fieldsUnchanged) {
      // Sub-minute precision would otherwise be lost by the HH:MM inputs —
      // if the user didn't touch the time fields, keep the exact original
      // timestamps rather than reconstructing (and misfiring the
      // crossed-midnight guess below for very short sessions).
      start = editingOriginalStart;
      end = editingOriginalEnd;
    } else {
      start = new Date(`${dateStr}T${startTime}:00`);
      end = new Date(`${dateStr}T${endTime}:00`);
      if (end < start) end = new Date(end.getTime() + 24 * 3600000); // crossed midnight
    }
  }

  if (end <= start) {
    errEl.textContent = 'End must be after start.';
    errEl.classList.remove('hidden');
    return;
  }

  const note = document.getElementById('entry-note').value.trim();

  try {
    currentItem = await updateItem(config, async (item) => {
      const { dayMinutes, nightMinutes } = await splitDayNightForSession(start, end, item.settings);
      const newSession = {
        id: editingSessionId || uid(),
        start: start.toISOString(),
        end: end.toISOString(),
        dayMinutes,
        nightMinutes,
        note: note || undefined,
        source: editingSessionId
          ? item.sessions.find((x) => x.id === editingSessionId)?.source || 'manual'
          : 'manual'
      };
      const sessions = editingSessionId
        ? item.sessions.map((x) => (x.id === editingSessionId ? newSession : x))
        : [...item.sessions, newSession];
      return { ...item, sessions };
    });
    closeEntryModal();
    renderAll();
  } catch (err) {
    errEl.textContent = err.message || 'Could not save. Try again.';
    errEl.classList.remove('hidden');
  }
}

async function deleteEntry() {
  if (!editingSessionId) return;
  if (!confirm('Delete this entry? This can\'t be undone.')) return;
  const idToDelete = editingSessionId;
  currentItem = await updateItem(config, (item) => ({
    ...item,
    sessions: item.sessions.filter((x) => x.id !== idToDelete)
  }));
  closeEntryModal();
  renderAll();
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

function wireSettingsEvents() {
  document.getElementById('use-astro-sun').addEventListener('change', updateAstroLocationVisibility);

  document.getElementById('use-current-location-btn').addEventListener('click', async () => {
    const msg = document.getElementById('astro-location-msg');
    msg.classList.add('hidden');
    const coords = await requestCurrentPosition();
    if (!coords) {
      msg.textContent = 'Could not get location. Enter lat/lon manually.';
      msg.classList.remove('hidden');
      return;
    }
    document.getElementById('astro-lat').value = coords.latitude;
    document.getElementById('astro-lon').value = coords.longitude;
    msg.textContent = 'Location captured.';
    msg.classList.remove('hidden');
  });

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const goalTotalHours = parseFloat(document.getElementById('goal-total').value) || 0;
    const goalNightHours = parseFloat(document.getElementById('goal-night').value) || 0;
    const dayStartHour = parseInt(document.getElementById('day-start').value, 10);
    const nightStartHour = parseInt(document.getElementById('night-start').value, 10);
    const useAstronomicalSun = document.getElementById('use-astro-sun').checked;
    const latRaw = document.getElementById('astro-lat').value.trim();
    const lonRaw = document.getElementById('astro-lon').value.trim();
    let latitude = latRaw === '' ? null : parseFloat(latRaw);
    let longitude = lonRaw === '' ? null : parseFloat(lonRaw);

    if (useAstronomicalSun && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
      const coords = await requestCurrentPosition();
      if (coords) {
        latitude = coords.latitude;
        longitude = coords.longitude;
        document.getElementById('astro-lat').value = latitude;
        document.getElementById('astro-lon').value = longitude;
      }
    }

    if (useAstronomicalSun && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
      alert('Location permission was denied or unavailable. Enter latitude/longitude manually, or disable astronomical mode.');
      return;
    }

    currentItem = await updateItem(config, (item) => ({
      ...item,
      settings: {
        ...item.settings,
        goalTotalHours,
        goalNightHours,
        dayStartHour,
        nightStartHour,
        useAstronomicalSun,
        latitude,
        longitude
      }
    }));
    renderAll();
    const msg = document.getElementById('settings-saved-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2000);
  });

  document.getElementById('gen-setup-code-btn').addEventListener('click', () => {
    const driver = document.getElementById('new-driver-name').value.trim();
    const output = document.getElementById('setup-code-output');
    if (!driver) {
      alert('Enter a driver name for the new device first.');
      return;
    }
    const code = encodeSetupCode({ ...config, driver });
    output.value = code;
    output.classList.remove('hidden');
  });

  document.getElementById('print-log-btn').addEventListener('click', () => {
    printLog(currentItem);
  });

  document.getElementById('download-backup-btn').addEventListener('click', () => {
    downloadBackup(currentItem);
  });

  document.getElementById('restore-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const msg = document.getElementById('restore-msg');
    if (!file) return;
    try {
      const text = await file.text();
      const { sessions, settings } = parseBackup(text);
      if (!confirm(`Restore ${sessions.length} session(s)? This replaces the current log for ${config.driver}.`)) {
        return;
      }
      currentItem = await updateItem(config, (item) => ({
        ...item,
        sessions,
        settings: normalizedSettings(settings || {})
      }));
      renderAll();
      msg.textContent = 'Restored successfully.';
      msg.classList.remove('hidden');
    } catch (err) {
      msg.textContent = err.message || 'Could not restore that file.';
      msg.classList.remove('hidden');
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('reset-device-btn').addEventListener('click', () => {
    if (!confirm('Disconnect this device? You\'ll need a setup code to reconnect.')) return;
    clearConfig();
    location.reload();
  });
}

// ---------------------------------------------------------------------
// Wire everything once, on boot
// ---------------------------------------------------------------------

function wireAppEvents() {
  wireTabEvents();
  wireHomeEvents();
  wireEntryModalEvents();
  wireSettingsEvents();
}
