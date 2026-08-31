import {
  SCHEMA_VERSION,
  copyAllowedActive,
  copyAllowedSession,
  copyAllowedTombstone,
  formatDate,
  formatMinutes,
  formatTime,
  compareClientVersions,
  CLIENT_VERSION,
  normalizeRemoteDocument,
  safeJsonParse,
  substantiveSessionEquals
} from './utils.js';

const BACKUP_VERSION = 2;
const CLIENT_VERSION_RE = /^v\d+(?:\.\d+)*$/;

export function assertBackupCompatible(document, { legacy = false } = {}) {
  const schemaVersion = document?.schemaVersion;
  if (schemaVersion !== undefined &&
      (!Number.isInteger(schemaVersion) || schemaVersion < 1)) {
    throw new Error('Backup schema metadata is invalid.');
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error('This backup requires a newer app schema and cannot be previewed or restored.');
  }
  const minimumClientVersion = document?.minimumClientVersion;
  if (minimumClientVersion !== undefined &&
      (typeof minimumClientVersion !== 'string' || !CLIENT_VERSION_RE.test(minimumClientVersion))) {
    throw new Error('Backup client-version metadata is invalid.');
  }
  if (minimumClientVersion !== undefined &&
      compareClientVersions(CLIENT_VERSION, minimumClientVersion) < 0) {
    throw new Error('This backup requires a newer app version and cannot be previewed or restored.');
  }
  if (!legacy && (schemaVersion === undefined || minimumClientVersion === undefined)) {
    throw new Error('Backup compatibility metadata is missing.');
  }
}

function appendCell(row, value, tagName = 'td') {
  const cell = row.ownerDocument.createElement(tagName);
  cell.textContent = String(value ?? '');
  row.appendChild(cell);
  return cell;
}

export function printLog(item) {
  const win = window.open('', '_blank');
  if (!win) throw new Error('Allow pop-ups to print the log.');
  win.opener = null;
  const doc = win.document;
  doc.title = 'Driving Log';
  const style = doc.createElement('style');
  style.textContent = `
    body{font-family:-apple-system,Helvetica,Arial,sans-serif;color:#111;padding:24px}
    h1{font-size:20px;margin-bottom:4px}.meta{color:#555;margin-bottom:20px;font-size:13px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #ccc;text-align:left;padding:6px 8px}
    th{border-bottom:2px solid #111}tfoot td{border-top:2px solid #111;border-bottom:0;font-weight:bold}
    .sig{margin-top:48px;display:flex;gap:48px}.sig div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:12px;color:#555}
    @media print{@page{margin:1in}}
  `;
  doc.head.appendChild(style);
  const heading = doc.createElement('h1');
  heading.textContent = 'Supervised Driving Practice Log';
  doc.body.appendChild(heading);
  const meta = doc.createElement('div');
  meta.className = 'meta';
  meta.textContent = `Driver: ${item.driverId} • Printed ${new Date().toLocaleDateString()}`;
  doc.body.appendChild(meta);
  const table = doc.createElement('table');
  const head = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  ['Date', 'Time', 'Day', 'Night', 'Type', 'Note'].forEach((label) => appendCell(headRow, label, 'th'));
  head.appendChild(headRow);
  table.appendChild(head);
  const body = doc.createElement('tbody');
  const sessions = [...item.sessions].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const session of sessions) {
    const row = doc.createElement('tr');
    appendCell(row, formatDate(session.start));
    appendCell(row, session.timeKind === 'duration'
      ? 'Duration only'
      : `${formatTime(session.start)}–${formatTime(session.end)}`);
    appendCell(row, formatMinutes(session.dayMinutes));
    appendCell(row, formatMinutes(session.nightMinutes));
    appendCell(row, session.source === 'manual' ? 'Manual' : 'Logged');
    appendCell(row, session.note || '');
    body.appendChild(row);
  }
  table.appendChild(body);
  const foot = doc.createElement('tfoot');
  const totalRow = doc.createElement('tr');
  const totalDay = sessions.reduce((sum, session) => sum + session.dayMinutes, 0);
  const totalNight = sessions.reduce((sum, session) => sum + session.nightMinutes, 0);
  const label = appendCell(totalRow, 'Total');
  label.colSpan = 2;
  appendCell(totalRow, formatMinutes(totalDay));
  appendCell(totalRow, formatMinutes(totalNight));
  appendCell(totalRow, '');
  appendCell(totalRow, '');
  foot.appendChild(totalRow);
  table.appendChild(foot);
  doc.body.appendChild(table);
  const signatures = doc.createElement('div');
  signatures.className = 'sig';
  ['Parent / Supervising Driver Signature', 'Date'].forEach((text) => {
    const line = doc.createElement('div');
    line.textContent = text;
    signatures.appendChild(line);
  });
  doc.body.appendChild(signatures);
  win.setTimeout(() => win.print(), 50);
}

function backupPayload(item) {
  return {
    backupVersion: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    minimumClientVersion: item.minimumClientVersion,
    driverId: item.driverId,
    exportedAt: new Date().toISOString(),
    migratedAt: item.migratedAt,
    active: item.active ? copyAllowedActive(item.active) : null,
    sessions: item.sessions.map(copyAllowedSession),
    deletedSessions: item.deletedSessions.map(copyAllowedTombstone),
    settings: {
      goalTotalHours: item.settings.goalTotalHours,
      goalNightHours: item.settings.goalNightHours,
      dayStartHour: item.settings.dayStartHour,
      nightStartHour: item.settings.nightStartHour,
      useAstronomicalSun: item.settings.useAstronomicalSun,
      latitude: item.settings.latitude,
      longitude: item.settings.longitude
    }
  };
}

function safeFilenamePart(value) {
  const cleaned = String(value || 'driver').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 64) || 'driver';
}

export function downloadBackup(item) {
  const blob = new Blob([JSON.stringify(backupPayload(item), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `drivelog-${safeFilenamePart(item.driverId)}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function parseBackup(text, targetDriverId) {
  let parsed;
  try {
    parsed = safeJsonParse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup file is not an object.');
  }
  if (!Array.isArray(parsed.sessions)) throw new Error('Backup file is missing a sessions list.');
  if (!parsed.settings || typeof parsed.settings !== 'object') {
    throw new Error('Backup file is missing settings.');
  }
  const legacy = parsed.backupVersion === undefined;
  if (!legacy && parsed.backupVersion !== BACKUP_VERSION) {
    throw new Error('This backup version is not supported by this app.');
  }
  assertBackupCompatible(parsed, { legacy });
  const raw = {
    driverId: targetDriverId,
    version: 0,
    schemaVersion: legacy ? undefined : parsed.schemaVersion,
    minimumClientVersion: parsed.minimumClientVersion,
    migratedAt: parsed.migratedAt,
    active: parsed.active ?? null,
    sessions: parsed.sessions,
    deletedSessions: parsed.deletedSessions ?? [],
    settings: parsed.settings
  };
  const normalized = normalizeRemoteDocument(raw, {
    driverId: targetDriverId,
    now: parsed.exportedAt
  });
  if (normalized.document.quarantine.length) {
    throw new Error(`Backup contains ${normalized.document.quarantine.length} invalid record(s); restore was blocked.`);
  }
  assertBackupCompatible(normalized.document);
  return { document: normalized.document, issues: normalized.issues, legacy };
}

export function previewBackup(current, incoming) {
  assertBackupCompatible(incoming);
  const currentById = new Map(current.sessions.map((session) => [session.id, session]));
  let creates = 0;
  let changes = 0;
  for (const session of incoming.sessions) {
    const existing = currentById.get(session.id);
    if (!existing) creates++;
    else if (!substantiveSessionEquals(existing, session)) changes++;
  }
  const deletions = incoming.deletedSessions.filter((tombstone) => currentById.has(tombstone.id)).length;
  return {
    creates,
    changes,
    deletions,
    total: creates + changes + deletions,
    summary: `${creates} new, ${changes} changed, ${deletions} deleted`
  };
}
