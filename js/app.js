import {
  clearConfig,
  decodeSetupCode,
  encodeSetupCode,
  loadConfig,
  saveConfig,
  validateConfig
} from './config.js';
import { LogRepository } from './log-repository.js';
import {
  CLIENT_VERSION,
  createId,
  formatDate,
  formatElapsed,
  formatHoursDecimal,
  formatMinutes,
  formatTime,
  normalizeSettings,
  splitDayNight
} from './utils.js';
import { downloadBackup, parseBackup, previewBackup, printLog } from './export.js';
import { getCutoffsForDate, hasSunConfig, purgeLegacySunCache } from './sun.js';

const APP_VERSION = CLIENT_VERSION;
const POLL_INTERVAL_MS = 30000;

purgeLegacySunCache();

let config = loadConfig();
let repository = null;
let state = null;
let tickHandle = null;
let pollHandle = null;
let editingSessionId = null;
let editingOriginalStart = null;
let editingOriginalEnd = null;
let mergeSourceIds = null;
let technicalMergeConflictId = null;
let isEntryMutationBusy = false;
let controlsBeforeBusy = null;
let swRegistration = null;
let isRefreshingForUpdate = false;
let latestPublishedVersion = APP_VERSION;
let eventsWired = false;
let pendingBackup = null;

if (config) {
  showApp();
  boot();
} else {
  showSetupGate();
}

registerServiceWorker();

async function boot() {
  document.getElementById('driver-name-label').textContent = config.driver;
  setVersionBadge(`${APP_VERSION} current`);
  repository = new LogRepository(config);
  try {
    await repository.init();
  } catch {
    showFatalLocalStorageError();
    return;
  }
  repository.subscribe((nextState) => {
    state = nextState;
    renderAll();
  });
  wireAppEvents();
  startTicking();
  startPolling();
  updateVersionBadge();
  repository.sync('launch').catch(() => {});
}

function showFatalLocalStorageError() {
  const warning = document.getElementById('storage-warning');
  warning.textContent = 'Offline storage is unavailable in this browser. The log is read-only until storage access is restored.';
  warning.classList.remove('hidden');
  document.querySelectorAll('button, input, textarea, select').forEach((control) => {
    if (!control.closest('#update-banner')) control.disabled = true;
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((registration) => {
      swRegistration = registration;
      wireUpdatePrompt(registration);
    })
    .catch(() => {});
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
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
    });
  });
}

function showUpdateBanner(message = 'A new version is ready.') {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const button = document.getElementById('update-now-btn');
  banner.classList.remove('hidden');
  text.textContent = message;
  setVersionBadge(`${APP_VERSION} update ready`, true);
  button.textContent = 'Refresh';
  button.disabled = false;
  button.onclick = () => {
    if (state?.dirtyCount) {
      text.textContent = 'Sync or export pending changes before refreshing.';
      return;
    }
    button.disabled = true;
    const waiting = swRegistration?.waiting;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  };
}

function setVersionBadge(text, outdated = false) {
  const badge = document.getElementById('app-version');
  if (!badge) return;
  badge.textContent = text;
  badge.classList.toggle('outdated', outdated);
}

async function updateVersionBadge() {
  try {
    const response = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    latestPublishedVersion = String(payload?.version || APP_VERSION);
    if (latestPublishedVersion !== APP_VERSION) {
      setVersionBadge(`${APP_VERSION} → ${latestPublishedVersion}`, true);
      if (!swRegistration?.waiting) showUpdateBanner(`Release ${latestPublishedVersion} is available.`);
    }
  } catch {
    // Version metadata is advisory and must not affect offline use.
  }
}

function checkForUpdates() {
  setVersionBadge('Checking…');
  Promise.resolve(swRegistration?.update())
    .then(updateVersionBadge)
    .finally(() => {
      if (latestPublishedVersion === APP_VERSION) setVersionBadge(`${APP_VERSION} current`);
    });
}

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
  const advanced = document.getElementById('setup-advanced');
  const input = document.getElementById('setup-code-input');
  document.getElementById('show-advanced').addEventListener('click', () => {
    pasteBox.classList.add('hidden');
    advanced.classList.remove('hidden');
  });
  document.getElementById('show-paste').addEventListener('click', () => {
    advanced.classList.add('hidden');
    pasteBox.classList.remove('hidden');
  });
  pasteBox.addEventListener('submit', (event) => {
    event.preventDefault();
    const error = document.getElementById('setup-error');
    try {
      config = saveConfig(decodeSetupCode(input.value));
      input.value = '';
      showApp();
      boot();
    } catch (caught) {
      error.textContent = caught.message;
      error.classList.remove('hidden');
    }
  });
  document.getElementById('setup-advanced-submit').addEventListener('click', () => {
    const error = document.getElementById('setup-advanced-error');
    try {
      config = saveConfig(validateConfig({
        region: document.getElementById('adv-region').value,
        idp: document.getElementById('adv-idp').value,
        table: document.getElementById('adv-table').value,
        driver: document.getElementById('adv-driver').value
      }));
      showApp();
      boot();
    } catch (caught) {
      error.textContent = caught.message;
      error.classList.remove('hidden');
    }
  });
}

function startPolling() {
  clearInterval(pollHandle);
  pollHandle = setInterval(() => repository?.sync('poll').catch(() => {}), POLL_INTERVAL_MS);
}

function startTicking() {
  clearInterval(tickHandle);
  tickHandle = setInterval(updateTimerDisplay, 1000);
}

function renderAll() {
  if (!state) return;
  renderStatus();
  renderHome();
  renderHeaderProgress();
  renderProgress();
  renderLog();
  renderConflicts();
  renderSettingsForm();
}

function renderStatus() {
  const labels = {
    offline: 'offline',
    pending: `pending ${state.dirtyCount}`,
    syncing: 'syncing',
    attention: 'needs attention',
    synced: 'synced'
  };
  const dot = document.getElementById('sync-dot');
  dot.className = `sync-dot ${state.status}`;
  document.getElementById('sync-status-label').textContent = labels[state.status] || state.status;
  document.getElementById('manual-sync-btn').disabled = state.status === 'syncing';
  const conflictButton = document.getElementById('conflicts-btn');
  conflictButton.classList.toggle('hidden', state.conflicts.length === 0);
  conflictButton.textContent = `Needs attention (${state.conflicts.length})`;
  document.getElementById('update-required-gate').classList.toggle('hidden', !state.updateRequired);
  const warning = document.getElementById('storage-warning');
  const messages = [];
  if (state.sizeWarning) messages.push(`Shared logbook is ${Math.round(state.remoteBytes / 1024)} KB; export a backup before it approaches DynamoDB's 400 KB limit.`);
  if (state.lastError) messages.push(state.lastError);
  warning.replaceChildren();
  if (messages.length) {
    messages.forEach((message) => {
      const paragraph = document.createElement('p');
      paragraph.textContent = message;
      warning.appendChild(paragraph);
    });
  }
  warning.classList.toggle('hidden', messages.length === 0);
  document.getElementById('sync-detail').textContent = [
    labels[state.status],
    state.lastSyncAt ? `Last confirmed sync ${new Date(state.lastSyncAt).toLocaleString()}.` : 'No confirmed sync yet.',
    state.dirtyCount ? `${state.dirtyCount} local change(s) are durable on this device.` : 'No pending local changes.'
  ].join(' ');
  const storage = document.getElementById('storage-status-msg');
  storage.textContent = state.storagePersisted === true
    ? 'Offline storage protection was granted by this browser.'
    : state.storagePersisted === false
      ? 'The browser did not grant persistent storage; keep current backups.'
      : 'Persistent storage will be requested after the first successful sync.';
  const blockWrites = state.updateRequired;
  for (const id of ['start-stop-btn', 'add-entry-btn', 'save-settings-btn']) {
    document.getElementById(id).disabled = blockWrites;
  }
}

function updateTimerDisplay() {
  const display = document.getElementById('timer-display');
  if (!display || !state) return;
  display.textContent = state.item.active
    ? formatElapsed(Date.now() - Date.parse(state.item.active.startedAt))
    : '00:00:00';
}

function renderHome() {
  updateTimerDisplay();
  const active = state.item.active;
  const button = document.getElementById('start-stop-btn');
  const status = document.getElementById('timer-status');
  button.textContent = active ? 'Stop Drive' : 'Start Drive';
  button.classList.toggle('btn-start', !active);
  button.classList.toggle('btn-stop', !!active);
  status.textContent = active ? 'Drive in progress' : 'Ready to drive';
}

function computeTotals(sessions) {
  return sessions.reduce((totals, session) => {
    totals.dayMinutes += session.dayMinutes;
    totals.nightMinutes += session.nightMinutes;
    totals.totalMinutes += session.dayMinutes + session.nightMinutes;
    return totals;
  }, { dayMinutes: 0, nightMinutes: 0, totalMinutes: 0 });
}

function renderHeaderProgress() {
  const totals = computeTotals(state.item.sessions);
  const goalMinutes = state.item.settings.goalTotalHours * 60;
  const fraction = goalMinutes > 0 ? Math.min(totals.totalMinutes / goalMinutes, 1) : 0;
  document.getElementById('header-progress-fill').style.width = `${fraction * 100}%`;
  const remaining = Math.max(goalMinutes - totals.totalMinutes, 0);
  document.getElementById('header-progress-label').textContent =
    remaining ? `${formatHoursDecimal(remaining)} hrs left` : 'Goal reached';
}

function renderProgress() {
  const totals = computeTotals(state.item.sessions);
  const settings = state.item.settings;
  const goalMinutes = settings.goalTotalHours * 60;
  document.getElementById('gauge-total-hours').textContent = formatHoursDecimal(totals.totalMinutes);
  document.getElementById('gauge-goal-hours').textContent = settings.goalTotalHours;
  document.getElementById('day-hours-value').textContent =
    `${formatHoursDecimal(totals.dayMinutes)} / ${Math.max(0, settings.goalTotalHours - settings.goalNightHours)} hrs`;
  document.getElementById('night-hours-value').textContent =
    `${formatHoursDecimal(totals.nightMinutes)} / ${settings.goalNightHours} hrs`;
  const circumference = 2 * Math.PI * 92;
  const dayFraction = goalMinutes ? Math.min(totals.dayMinutes / goalMinutes, 1) : 0;
  const nightFraction = goalMinutes ? Math.min(totals.nightMinutes / goalMinutes, 1 - dayFraction) : 0;
  const day = document.getElementById('gauge-day');
  const night = document.getElementById('gauge-night');
  day.style.strokeDasharray = `${circumference * dayFraction} ${circumference}`;
  night.style.strokeDasharray = `${circumference * nightFraction} ${circumference}`;
  night.style.strokeDashoffset = `${-circumference * dayFraction}`;
  renderWeeklyChart();
}

function startOfWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}

function computeWeeklyTotals(sessions) {
  const current = startOfWeek(new Date());
  const weeks = [];
  for (let offset = 7; offset >= 0; offset--) {
    const start = new Date(current);
    start.setDate(start.getDate() - offset * 7);
    weeks.push({ start, dayMinutes: 0, nightMinutes: 0 });
  }
  const byStart = new Map(weeks.map((week) => [week.start.getTime(), week]));
  sessions.forEach((session) => {
    const week = byStart.get(startOfWeek(new Date(session.start)).getTime());
    if (week) {
      week.dayMinutes += session.dayMinutes;
      week.nightMinutes += session.nightMinutes;
    }
  });
  return weeks;
}

function renderWeeklyChart() {
  const container = document.getElementById('weekly-chart');
  container.replaceChildren();
  const weeks = computeWeeklyTotals(state.item.sessions);
  const max = Math.max(60, ...weeks.map((week) => week.dayMinutes + week.nightMinutes));
  const current = startOfWeek(new Date()).getTime();
  weeks.forEach((week) => {
    const column = document.createElement('div');
    column.className = `week-bar-col${week.start.getTime() === current ? ' is-current' : ''}`;
    const total = week.dayMinutes + week.nightMinutes;
    column.title = `Week of ${week.start.toLocaleDateString()}: ${formatHoursDecimal(total)} hrs`;
    const totalLabel = document.createElement('span');
    totalLabel.className = 'week-bar-total mono';
    totalLabel.textContent = total ? formatHoursDecimal(total) : '';
    const track = document.createElement('div');
    track.className = 'week-bar-track';
    const day = document.createElement('div');
    day.className = 'week-bar-day';
    day.style.height = `${week.dayMinutes / max * 100}%`;
    const night = document.createElement('div');
    night.className = 'week-bar-night';
    night.style.height = `${week.nightMinutes / max * 100}%`;
    track.append(day, night);
    const label = document.createElement('span');
    label.className = 'week-bar-label';
    label.textContent = week.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    column.append(totalLabel, track, label);
    container.appendChild(column);
  });
}

function appendBadge(container, text, className) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${className}`;
  badge.textContent = text;
  container.appendChild(badge);
}

function renderLog() {
  const list = document.getElementById('log-list');
  list.replaceChildren();
  const sessions = [...state.item.sessions].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No drives logged yet. Start one, or add a past entry.';
    list.appendChild(empty);
    return;
  }
  const pendingIds = new Set(repository.dirty.filter((dirty) => dirty.kind === 'session').map((dirty) => dirty.entityId));
  const attentionIds = new Set();
  state.conflicts.forEach((conflict) => {
    if (conflict.entityId) attentionIds.add(conflict.entityId);
    (conflict.memberIds || []).forEach((id) => attentionIds.add(id));
    (conflict.candidates || []).forEach((candidate) => {
      if (candidate.kind === 'session') attentionIds.add(candidate.entityId);
    });
  });
  sessions.forEach((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `log-row${pendingIds.has(session.id) ? ' pending' : ''}${attentionIds.has(session.id) ? ' attention' : ''}`;
    row.dataset.id = session.id;
    const top = document.createElement('div');
    top.className = 'log-row-top';
    const date = document.createElement('span');
    date.className = 'log-row-date';
    date.textContent = formatDate(session.start);
    const duration = document.createElement('span');
    duration.className = 'log-row-duration';
    duration.textContent = formatMinutes(session.dayMinutes + session.nightMinutes);
    top.append(date, duration);
    const time = document.createElement('div');
    time.className = 'log-row-duration';
    time.textContent = session.timeKind === 'duration'
      ? 'Duration only'
      : `${formatTime(session.start)} – ${formatTime(session.end)}`;
    const split = document.createElement('div');
    split.className = 'log-split-bar';
    const total = session.dayMinutes + session.nightMinutes;
    const day = document.createElement('div');
    day.className = 'log-split-day';
    day.style.width = `${total ? session.dayMinutes / total * 100 : 0}%`;
    const night = document.createElement('div');
    night.className = 'log-split-night';
    night.style.width = `${total ? session.nightMinutes / total * 100 : 0}%`;
    split.append(day, night);
    row.append(top, time, split);
    if (session.note) {
      const note = document.createElement('div');
      note.className = 'log-row-note';
      note.textContent = session.note;
      row.appendChild(note);
    }
    const badges = document.createElement('div');
    badges.className = 'log-row-badges';
    if (session.source === 'manual') appendBadge(badges, 'Manually added', '');
    if (pendingIds.has(session.id)) appendBadge(badges, 'Pending sync', 'pending');
    if (attentionIds.has(session.id)) appendBadge(badges, 'Needs attention', 'attention');
    if (badges.childElementCount) row.appendChild(badges);
    row.addEventListener('click', () => openEntryModal(session.id));
    list.appendChild(row);
  });
}

function conflictButton(text, handler, { primary = false, danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-small${primary ? ' btn-primary' : ''}${danger ? ' danger' : ''}`;
  button.textContent = text;
  button.addEventListener('click', handler);
  return button;
}

function candidateSummary(candidate) {
  const value = candidate.local || candidate.remote || candidate.base;
  if (!value) return `${candidate.kind}: deleted/stopped`;
  if (candidate.kind === 'active') {
    return `Active from ${new Date(value.startedAt).toLocaleString()} · revision ${value.revision} · device ${value.updatedBy}`;
  }
  return `${formatDate(value.start)} · ${formatMinutes(value.dayMinutes + value.nightMinutes)} · revision ${value.revision} · device ${value.updatedBy}`;
}

function renderConflicts() {
  const list = document.getElementById('conflict-list');
  list.replaceChildren();
  if (!state.conflicts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No conflicts need attention.';
    list.appendChild(empty);
    return;
  }
  state.conflicts.forEach((conflict) => {
    const card = document.createElement('article');
    card.className = 'conflict-card';
    const heading = document.createElement('h3');
    heading.textContent = conflict.title || (conflict.type === 'duplicate' ? 'Likely duplicate entries' : 'Overlapping entries');
    const message = document.createElement('p');
    message.textContent = conflict.message ||
      `${conflict.members.length} entries ${conflict.type === 'duplicate' ? 'appear to duplicate one another' : 'have overlapping times'}.`;
    card.append(heading, message);
    if (conflict.confidenceHint) {
      const hint = document.createElement('p');
      hint.textContent = `Confidence hint: ${conflict.confidenceHint}.`;
      card.appendChild(hint);
    }
    (conflict.candidates || []).forEach((candidate) => {
      const detail = document.createElement('div');
      detail.className = 'conflict-candidate';
      detail.textContent = candidateSummary(candidate);
      card.appendChild(detail);
    });
    (conflict.members || []).forEach((member) => {
      const detail = document.createElement('div');
      detail.className = 'conflict-candidate';
      detail.textContent = `${formatDate(member.start)} · ${formatTime(member.start)}–${formatTime(member.end)} · ${formatMinutes(member.dayMinutes + member.nightMinutes)}${member.note ? ` · ${member.note}` : ''}`;
      card.appendChild(detail);
    });
    const actions = document.createElement('div');
    actions.className = 'conflict-actions';
    if (conflict.type === 'technical' || conflict.type === 'active') {
      actions.append(
        conflictButton('Keep local', () => resolveTechnical(conflict.id, 'local'), { primary: true }),
        conflictButton('Discard local / keep remote', () => resolveTechnical(conflict.id, 'remote'), { danger: true })
      );
      if (conflict.type === 'technical') {
        actions.appendChild(conflictButton('Keep both', () => resolveTechnical(conflict.id, 'both')));
        const localCandidate = conflict.candidates?.find((candidate) => candidate.kind === 'session' && candidate.local);
        if (localCandidate) {
          actions.appendChild(conflictButton('Edit local', () => {
            switchToTab('log');
            openEntryModal(localCandidate.entityId);
          }));
        }
        const mergeCandidate = conflict.candidates?.find((candidate) =>
          candidate.kind === 'session' &&
          candidate.local?.timeKind === 'explicit' &&
          candidate.remote?.timeKind === 'explicit'
        );
        if (mergeCandidate) {
          actions.appendChild(conflictButton('Merge', () => openTechnicalMergeModal(conflict), { primary: true }));
        }
      }
    } else if (conflict.type === 'duplicate' || conflict.type === 'overlap') {
      actions.append(
        conflictButton('Keep both', () => repository.acknowledgeDerivedConflict(conflict.id)),
        conflictButton('Edit', () => {
          switchToTab('log');
          openEntryModal(conflict.memberIds[0]);
        }),
        conflictButton('Merge', () => openMergeModal(conflict), { primary: true })
      );
    } else if (conflict.code === 'legacy-active') {
      actions.append(
        conflictButton('Accept active drive', () => repository.resolveDataConflict(conflict.id, 'accept'), { primary: true }),
        conflictButton('Clear active drive', async () => {
          if (!confirm('Clear the active drive written by an older client?')) return;
          await repository.resolveDataConflict(conflict.id, 'clear');
          repository.sync('legacy-active-resolution').catch(() => {});
        }, { danger: true })
      );
    } else {
      actions.appendChild(conflictButton('Retry sync', () => manualSync(), { primary: true }));
    }
    card.appendChild(actions);
    list.appendChild(card);
  });
}

async function resolveTechnical(id, action) {
  if ((action === 'remote' || action === 'discard') &&
      !confirm('Discard the local version and keep the remote value? This cannot be undone.')) return;
  try {
    await repository.resolveTechnicalConflict(id, action);
    repository.sync('resolution').catch(() => {});
  } catch (error) {
    alert(error.message || 'Could not resolve the conflict.');
  }
}

function renderSettingsForm() {
  const settings = normalizeSettings(state.item.settings);
  const settingsScreen = document.getElementById('screen-settings');
  if (settingsScreen.contains(document.activeElement)) return;
  document.getElementById('goal-total').value = settings.goalTotalHours;
  document.getElementById('goal-night').value = settings.goalNightHours;
  document.getElementById('day-start').value = settings.dayStartHour;
  document.getElementById('night-start').value = settings.nightStartHour;
  document.getElementById('use-astro-sun').checked = settings.useAstronomicalSun;
  document.getElementById('astro-lat').value = settings.latitude ?? '';
  document.getElementById('astro-lon').value = settings.longitude ?? '';
  updateAstroLocationVisibility();
}

function switchToTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.screen === name));
  document.querySelectorAll('main > .screen').forEach((screen) => screen.classList.add('hidden'));
  document.getElementById(`screen-${name}`).classList.remove('hidden');
}

function wireAppEvents() {
  if (eventsWired) return;
  eventsWired = true;
  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => switchToTab(tab.dataset.screen))
  );
  document.getElementById('header-progress').addEventListener('click', () => switchToTab('progress'));
  document.getElementById('conflicts-btn').addEventListener('click', () => switchToTab('conflicts'));
  document.getElementById('sync-status-btn').addEventListener('click', () => switchToTab('conflicts'));
  document.getElementById('close-conflicts-btn').addEventListener('click', () => switchToTab('log'));
  document.getElementById('manual-sync-btn').addEventListener('click', manualSync);
  document.getElementById('app-version').addEventListener('click', checkForUpdates);
  window.addEventListener('online', () => repository.sync('online').catch(() => {}));
  window.addEventListener('offline', () => {
    repository.status = 'offline';
    repository.recompute();
    repository.notify();
  });
  wireHomeEvents();
  wireEntryEvents();
  wireSettingsEvents();
}

async function manualSync() {
  try {
    await repository.sync('manual');
  } catch {
    // Repository exposes a safe, non-credential error in status.
  }
}

function wireHomeEvents() {
  document.getElementById('start-stop-btn').addEventListener('click', async () => {
    const button = document.getElementById('start-stop-btn');
    button.disabled = true;
    try {
      if (state.item.active) {
        const active = state.item.active;
        const end = new Date();
        const start = new Date(active.startedAt);
        const split = await splitDayNightForSession(start, end, state.item.settings);
        const session = await repository.stopActive({
          id: createId(),
          start: start.toISOString(),
          end: end.toISOString(),
          dayMinutes: split.dayMinutes,
          nightMinutes: split.nightMinutes,
          source: 'live',
          timeKind: 'explicit'
        });
        openEntryModal(session.id);
      } else {
        await repository.startActive();
      }
      repository.sync('active-change').catch(() => {});
    } catch (error) {
      alert(error.message || 'Could not update the active drive.');
    } finally {
      button.disabled = state?.updateRequired || false;
    }
  });
}

function wireEntryEvents() {
  document.getElementById('add-entry-btn').addEventListener('click', () => openEntryModal(null));
  document.getElementById('entry-cancel-btn').addEventListener('click', closeEntryModal);
  document.getElementById('mode-times').addEventListener('click', () => setEntryMode('times'));
  document.getElementById('mode-duration').addEventListener('click', () => setEntryMode('duration'));
  document.getElementById('entry-save-btn').addEventListener('click', saveEntry);
  document.getElementById('entry-delete-btn').addEventListener('click', deleteEntry);
}

function setEntryMode(mode) {
  if (isEntryMutationBusy) return;
  document.getElementById('mode-times').classList.toggle('active', mode === 'times');
  document.getElementById('mode-duration').classList.toggle('active', mode === 'duration');
  document.getElementById('entry-times-fields').classList.toggle('hidden', mode !== 'times');
  document.getElementById('entry-duration-fields').classList.toggle('hidden', mode !== 'duration');
}

function openEntryModal(sessionId) {
  if (isEntryMutationBusy) return;
  mergeSourceIds = null;
  technicalMergeConflictId = null;
  editingSessionId = sessionId;
  const session = sessionId ? state.item.sessions.find((entry) => entry.id === sessionId) : null;
  if (sessionId && !session) return;
  const now = new Date();
  document.getElementById('entry-modal-title').textContent = session ? 'Edit Entry' : 'Add Entry';
  document.getElementById('entry-delete-btn').classList.toggle('hidden', !session);
  document.getElementById('entry-error').classList.add('hidden');
  editingOriginalStart = session ? new Date(session.start) : null;
  editingOriginalEnd = session ? new Date(session.end) : null;
  document.getElementById('entry-date').value = toDateInputValue(editingOriginalStart || now);
  document.getElementById('entry-start-time').value = session ? toTimeInputValue(editingOriginalStart) : '';
  document.getElementById('entry-end-time').value = session ? toTimeInputValue(editingOriginalEnd) : '';
  document.getElementById('entry-duration').value = session
    ? session.dayMinutes + session.nightMinutes
    : '';
  document.getElementById('entry-duration-period').value =
    session && session.nightMinutes > session.dayMinutes ? 'night' : 'day';
  document.getElementById('entry-note').value = session?.note || '';
  setEntryMode(session?.timeKind === 'duration' ? 'duration' : 'times');
  document.getElementById('entry-modal').classList.remove('hidden');
}

function openMergeModal(conflict) {
  const members = conflict.members;
  const start = new Date(Math.min(...members.map((member) => Date.parse(member.start))));
  const end = new Date(Math.max(...members.map((member) => Date.parse(member.end))));
  openEntryModal(null);
  mergeSourceIds = [...conflict.memberIds];
  document.getElementById('entry-modal-title').textContent = 'Merge Entries';
  document.getElementById('entry-date').value = toDateInputValue(start);
  document.getElementById('entry-start-time').value = toTimeInputValue(start);
  document.getElementById('entry-end-time').value = toTimeInputValue(end);
  document.getElementById('entry-note').value = members.map((member) => member.note).filter(Boolean).join(' / ');
  switchToTab('log');
}

function openTechnicalMergeModal(conflict) {
  const candidate = conflict.candidates.find((entry) => entry.kind === 'session');
  const members = [candidate.local, candidate.remote].filter(Boolean);
  const start = new Date(Math.min(...members.map((member) => Date.parse(member.start))));
  const end = new Date(Math.max(...members.map((member) => Date.parse(member.end))));
  openEntryModal(null);
  technicalMergeConflictId = conflict.id;
  document.getElementById('entry-modal-title').textContent = 'Merge Local and Remote';
  document.getElementById('entry-date').value = toDateInputValue(start);
  document.getElementById('entry-start-time').value = toTimeInputValue(start);
  document.getElementById('entry-end-time').value = toTimeInputValue(end);
  document.getElementById('entry-note').value = members.map((member) => member.note).filter(Boolean).join(' / ');
  switchToTab('log');
}

function closeEntryModal() {
  if (isEntryMutationBusy) return;
  hideEntryModal();
}

function hideEntryModal() {
  document.getElementById('entry-modal').classList.add('hidden');
  editingSessionId = null;
  mergeSourceIds = null;
  technicalMergeConflictId = null;
  editingOriginalStart = null;
  editingOriginalEnd = null;
}

function setEntryBusy(busy) {
  if (busy === isEntryMutationBusy) return;
  const controls = document.querySelectorAll('#entry-modal button, #entry-modal input, #entry-modal select, #entry-modal textarea');
  if (busy) {
    controlsBeforeBusy = new Map();
    controls.forEach((control) => {
      controlsBeforeBusy.set(control, control.disabled);
      control.disabled = true;
    });
  } else {
    controls.forEach((control) => {
      control.disabled = controlsBeforeBusy?.get(control) || false;
    });
    controlsBeforeBusy = null;
  }
  isEntryMutationBusy = busy;
}

function toDateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function saveEntry() {
  if (isEntryMutationBusy) return;
  const error = document.getElementById('entry-error');
  error.classList.add('hidden');
  try {
    setEntryBusy(true);
    const input = await readEntryForm();
    if (technicalMergeConflictId) await repository.resolveTechnicalWithMerged(technicalMergeConflictId, input);
    else if (mergeSourceIds) await repository.mergeSessions(input, mergeSourceIds);
    else await repository.saveSession(input);
    hideEntryModal();
    repository.sync('session-change').catch(() => {});
  } catch (caught) {
    error.textContent = caught.message || 'Could not save the entry.';
    error.classList.remove('hidden');
  } finally {
    setEntryBusy(false);
  }
}

async function readEntryForm() {
  const date = document.getElementById('entry-date').value;
  if (!date) throw new Error('Pick a date.');
  const durationMode = !document.getElementById('entry-duration-fields').classList.contains('hidden');
  let start;
  let end;
  if (durationMode) {
    const minutes = Number.parseInt(document.getElementById('entry-duration').value, 10);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1000000) {
      throw new Error('Enter a valid duration in minutes.');
    }
    const hour = document.getElementById('entry-duration-period').value === 'night' ? 23 : 13;
    start = new Date(`${date}T00:00:00`);
    start.setHours(hour, 0, 0, 0);
    end = new Date(start.getTime() + minutes * 60000);
  } else {
    const startText = document.getElementById('entry-start-time').value;
    const endText = document.getElementById('entry-end-time').value;
    if (!startText || !endText) throw new Error('Enter both a start and end time.');
    const unchanged = editingSessionId && editingOriginalStart && editingOriginalEnd &&
      date === toDateInputValue(editingOriginalStart) &&
      startText === toTimeInputValue(editingOriginalStart) &&
      endText === toTimeInputValue(editingOriginalEnd);
    if (unchanged) {
      start = editingOriginalStart;
      end = editingOriginalEnd;
    } else {
      start = new Date(`${date}T${startText}:00`);
      end = new Date(`${date}T${endText}:00`);
      if (end < start) end = new Date(end.getTime() + 86400000);
    }
  }
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('End must be after start.');
  }
  const split = durationMode
    ? document.getElementById('entry-duration-period').value === 'night'
      ? { dayMinutes: 0, nightMinutes: Math.round((end - start) / 60000) }
      : { dayMinutes: Math.round((end - start) / 60000), nightMinutes: 0 }
    : await splitDayNightForSession(start, end, state.item.settings);
  const existing = editingSessionId
    ? state.item.sessions.find((session) => session.id === editingSessionId)
    : null;
  return {
    id: editingSessionId || createId(),
    start: start.toISOString(),
    end: end.toISOString(),
    dayMinutes: split.dayMinutes,
    nightMinutes: split.nightMinutes,
    note: document.getElementById('entry-note').value.trim() || undefined,
    source: mergeSourceIds ? 'merged' : existing?.source || 'manual',
    timeKind: durationMode ? 'duration' : 'explicit'
  };
}

async function deleteEntry() {
  if (!editingSessionId || !confirm('Delete this entry? The deletion will sync to other devices.')) return;
  try {
    setEntryBusy(true);
    await repository.deleteSession(editingSessionId);
    hideEntryModal();
    repository.sync('session-delete').catch(() => {});
  } catch (error) {
    const element = document.getElementById('entry-error');
    element.textContent = error.message || 'Could not delete the entry.';
    element.classList.remove('hidden');
  } finally {
    setEntryBusy(false);
  }
}

function normalizedSettingsFromForm() {
  return normalizeSettings({
    goalTotalHours: Number(document.getElementById('goal-total').value),
    goalNightHours: Number(document.getElementById('goal-night').value),
    dayStartHour: Number(document.getElementById('day-start').value),
    nightStartHour: Number(document.getElementById('night-start').value),
    useAstronomicalSun: document.getElementById('use-astro-sun').checked,
    latitude: document.getElementById('astro-lat').value === '' ? null : Number(document.getElementById('astro-lat').value),
    longitude: document.getElementById('astro-lon').value === '' ? null : Number(document.getElementById('astro-lon').value)
  });
}

function wireSettingsEvents() {
  document.getElementById('use-astro-sun').addEventListener('change', updateAstroLocationVisibility);
  document.getElementById('use-current-location-btn').addEventListener('click', captureLocation);
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('gen-setup-code-btn').addEventListener('click', copySetupCode);
  document.getElementById('print-log-btn').addEventListener('click', () => printLog(state.item));
  document.getElementById('download-backup-btn').addEventListener('click', () => downloadBackup(state.item));
  document.getElementById('recover-snapshot-btn').addEventListener('click', recoverSnapshot);
  document.getElementById('restore-input').addEventListener('change', previewRestoreFile);
  document.getElementById('full-restore-input').addEventListener('change', fullRestoreFile);
  document.getElementById('backup-preview-cancel').addEventListener('click', closeBackupPreview);
  document.getElementById('backup-preview-confirm').addEventListener('click', applyBackupPreview);
  document.getElementById('reset-device-btn').addEventListener('click', disconnectDevice);
}

function updateAstroLocationVisibility() {
  document.getElementById('astro-location-fields').classList.toggle(
    'hidden',
    !document.getElementById('use-astro-sun').checked
  );
}

async function captureLocation() {
  const message = document.getElementById('astro-location-msg');
  const coords = await requestCurrentPosition();
  message.classList.remove('hidden');
  if (!coords) {
    message.textContent = 'Could not get location. Enter latitude/longitude manually.';
    return;
  }
  document.getElementById('astro-lat').value = coords.latitude;
  document.getElementById('astro-lon').value = coords.longitude;
  message.textContent = 'Location captured.';
}

async function saveSettings() {
  if (!navigator.onLine) {
    alert('Settings require a confirmed online sync.');
    return;
  }
  try {
    const settings = normalizedSettingsFromForm();
    if (settings.useAstronomicalSun && (!Number.isFinite(settings.latitude) || !Number.isFinite(settings.longitude))) {
      throw new Error('Enter latitude and longitude or disable astronomical mode.');
    }
    await repository.updateSettings(settings);
    const message = document.getElementById('settings-saved-msg');
    message.classList.remove('hidden');
    setTimeout(() => message.classList.add('hidden'), 2000);
  } catch (error) {
    alert(error.message || 'Could not save settings.');
  }
}

async function copySetupCode() {
  const driver = document.getElementById('new-driver-name').value.trim();
  if (!driver) {
    alert('Enter a driver name for the new device first.');
    return;
  }
  try {
    const code = encodeSetupCode({ ...config, driver });
    await navigator.clipboard.writeText(code);
    alert('Setup code copied. Share it only through a trusted channel; it grants direct logbook access.');
  } catch (error) {
    alert(error.message || 'Could not copy the setup code. Clipboard access may require HTTPS.');
  }
}

async function previewRestoreFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = parseBackup(await file.text(), config.driver);
    const preview = previewBackup(state.item, parsed.document);
    pendingBackup = parsed.document;
    document.getElementById('backup-preview-summary').textContent =
      `${preview.summary}. ${preview.total} local change(s) would be queued; current entries not named by the backup are retained.`;
    document.getElementById('backup-preview-warning').textContent =
      parsed.legacy ? 'Legacy backup metadata will be migrated before import.' : 'Settings are not changed by a normal import.';
    document.getElementById('backup-preview-modal').classList.remove('hidden');
  } catch (error) {
    showRestoreMessage(error.message || 'Could not read that backup.');
  }
}

async function recoverSnapshot() {
  try {
    const history = await repository.snapshotHistory();
    if (!history.length) {
      showRestoreMessage('No local remote snapshots are available yet.');
      return;
    }
    const choices = history.map((snapshot, index) =>
      `${index + 1}: remote version ${snapshot.version}, ${snapshot.sessions.length} session(s)`
    ).join('\n');
    const selection = Number.parseInt(prompt(`Choose a snapshot to preview:\n${choices}`), 10);
    if (!Number.isInteger(selection) || selection < 1 || selection > history.length) return;
    const chosen = history[selection - 1];
    const preview = previewBackup(state.item, chosen);
    pendingBackup = chosen;
    document.getElementById('backup-preview-summary').textContent =
      `${preview.summary}. The selected local snapshot will be applied as safe local changes.`;
    document.getElementById('backup-preview-warning').textContent =
      'Current entries not changed by this snapshot remain in place. Use full disaster restore only for complete replacement.';
    document.getElementById('backup-preview-modal').classList.remove('hidden');
  } catch (error) {
    showRestoreMessage(error.message || 'Could not recover that snapshot.');
  }
}

function closeBackupPreview() {
  pendingBackup = null;
  document.getElementById('backup-preview-modal').classList.add('hidden');
}

async function applyBackupPreview() {
  if (!pendingBackup) return;
  const button = document.getElementById('backup-preview-confirm');
  button.disabled = true;
  try {
    const count = await repository.importBackup(pendingBackup);
    closeBackupPreview();
    showRestoreMessage(`${count} backup change(s) queued safely.`);
    repository.sync('backup-import').catch(() => {});
  } catch (error) {
    showRestoreMessage(error.message || 'Could not import that backup.');
  } finally {
    button.disabled = false;
  }
}

async function fullRestoreFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = parseBackup(await file.text(), config.driver);
    if (!confirm('Full disaster restore replaces the remote log and clears conflict history only after a confirmed write. Continue?')) return;
    if (prompt('Type RESTORE to confirm full replacement.') !== 'RESTORE') return;
    await repository.fullRestore(parsed.document);
    showRestoreMessage('Full restore completed and was confirmed remotely.');
  } catch (error) {
    showRestoreMessage(error.message || 'Full restore failed; local data was retained.');
  }
}

function showRestoreMessage(text) {
  const message = document.getElementById('restore-msg');
  message.textContent = text;
  message.classList.remove('hidden');
}

function disconnectDevice() {
  if (state.dirtyCount && !confirm('This device has pending changes. Export a backup before disconnecting. Disconnect anyway?')) return;
  if (!confirm('Disconnect this device? You will need a setup code to reconnect.')) return;
  purgeLegacySunCache();
  clearConfig();
  location.reload();
}

async function requestCurrentPosition() {
  if (!navigator.geolocation) return null;
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 600000 }
    ));
    return {
      latitude: Number(position.coords.latitude.toFixed(4)),
      longitude: Number(position.coords.longitude.toFixed(4))
    };
  } catch {
    return null;
  }
}

async function calculationSettings(settings) {
  const safe = normalizeSettings(settings);
  if (!safe.useAstronomicalSun || hasSunConfig(safe)) return safe;
  const coords = await requestCurrentPosition();
  return coords ? { ...safe, ...coords } : safe;
}

async function splitDayNightForSession(start, end, settings) {
  const runtime = await calculationSettings(settings);
  if (!hasSunConfig(runtime)) {
    return splitDayNight(start, end, runtime.dayStartHour, runtime.nightStartHour);
  }
  let cursor = new Date(start);
  let dayMinutes = 0;
  let nightMinutes = 0;
  while (cursor < end) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const segmentEnd = midnight < end ? midnight : end;
    const cutoffs = await getCutoffsForDate(cursor, runtime);
    const split = splitDayNight(cursor, segmentEnd, cutoffs.dayStartHour, cutoffs.nightStartHour);
    dayMinutes += split.dayMinutes;
    nightMinutes += split.nightMinutes;
    cursor = segmentEnd;
  }
  return { dayMinutes, nightMinutes };
}
