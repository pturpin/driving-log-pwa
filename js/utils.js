export const SCHEMA_VERSION = 2;
export const CLIENT_VERSION = 'v0.18';
export const DUPLICATE_TOLERANCE_MINUTES = 5;
export const MAX_REMOTE_BYTES = 400 * 1024;
export const REMOTE_WARNING_BYTES = 250 * 1024;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^v\d+(?:\.\d+)*$/;
const SESSION_SOURCES = new Set(['manual', 'live', 'imported', 'legacy', 'merged']);
const TIME_KINDS = new Set(['explicit', 'duration']);
const KNOWN_TOP_LEVEL = new Set([
  'driverId', 'version', 'schemaVersion', 'minimumClientVersion', 'migratedAt',
  'active', 'sessions', 'deletedSessions', 'settings'
]);

export function createNullMap() {
  return Object.create(null);
}

export function safeJsonParse(text) {
  return JSON.parse(text, (key, value) => DANGEROUS_KEYS.has(key) ? undefined : value);
}

export function scrubUntrusted(value, depth = 0) {
  if (depth > 12) throw new Error('Data is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Data contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 5000) throw new Error('Data contains an oversized list.');
    return value.map((entry) => scrubUntrusted(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error('Data contains an unsupported value.');
  const clean = createNullMap();
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (value[key] === undefined) continue;
    clean[key] = scrubUntrusted(value[key], depth + 1);
  }
  return clean;
}

function boundedString(value, name, max, { optional = false, pattern = null } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) {
    throw new Error(`${name} is invalid.`);
  }
  return result;
}

function boundedNumber(value, name, min, max, { integer = false, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

export function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function isoTimestamp(value, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (!isValidIsoTimestamp(value)) throw new Error(`${name} is invalid.`);
  return new Date(value).toISOString();
}

export function validateEntityId(value, name = 'ID') {
  return boundedString(value, name, 64, { pattern: ID_RE });
}

export function defaultSettings() {
  return {
    goalTotalHours: 50,
    goalNightHours: 10,
    dayStartHour: 6,
    nightStartHour: 20,
    useAstronomicalSun: true,
    latitude: null,
    longitude: null
  };
}

export function normalizeSettings(input, issues = []) {
  const validCollection = input && typeof input === 'object' && !Array.isArray(input);
  const source = validCollection ? input : createNullMap();
  if (input !== undefined && !validCollection) {
    issues.push({ code: 'invalid-settings', message: 'The remote settings collection was invalid.' });
  }
  const defaults = defaultSettings();
  const numberOrDefault = (key, min, max, integer = false, nullable = false) => {
    if (source[key] === undefined) {
      issues.push({ code: 'missing-setting', message: `Added the default ${key} setting.` });
      return defaults[key];
    }
    try {
      return boundedNumber(source[key], `settings.${key}`, min, max, { integer, nullable });
    } catch {
      issues.push({ code: 'invalid-setting', message: `Ignored invalid ${key} setting.` });
      return defaults[key];
    }
  };
  return {
    goalTotalHours: numberOrDefault('goalTotalHours', 0, 10000),
    goalNightHours: numberOrDefault('goalNightHours', 0, 10000),
    dayStartHour: numberOrDefault('dayStartHour', 0, 23, true),
    nightStartHour: numberOrDefault('nightStartHour', 0, 23, true),
    useAstronomicalSun: typeof source.useAstronomicalSun === 'boolean'
      ? source.useAstronomicalSun
      : defaults.useAstronomicalSun,
    latitude: numberOrDefault('latitude', -90, 90, false, true),
    longitude: numberOrDefault('longitude', -180, 180, false, true)
  };
}

export function calculateRequirementProgress(
  actualDayMinutes,
  actualNightMinutes,
  totalGoalMinutes,
  nightGoalMinutes
) {
  const actualDay = Math.max(0, actualDayMinutes);
  const actualNight = Math.max(0, actualNightMinutes);
  const totalGoal = Math.max(0, totalGoalMinutes);
  const nightGoal = Math.max(0, nightGoalMinutes);
  const dayAllowance = Math.max(0, totalGoal - nightGoal);
  const creditedDayMinutes = Math.min(actualDay, dayAllowance);
  const creditedNightMinutes = Math.min(actualNight, totalGoal - creditedDayMinutes);
  const countedTotalMinutes = creditedDayMinutes + creditedNightMinutes;

  return {
    creditedDayMinutes,
    creditedNightMinutes,
    countedTotalMinutes,
    remainingMinutes: Math.max(0, totalGoal - countedTotalMinutes)
  };
}

export function emptyDocument(driverId) {
  return {
    driverId,
    version: 0,
    schemaVersion: SCHEMA_VERSION,
    minimumClientVersion: CLIENT_VERSION,
    migratedAt: null,
    active: null,
    sessions: [],
    deletedSessions: [],
    settings: defaultSettings(),
    passthrough: createNullMap(),
    quarantine: []
  };
}

function copySessionFields(raw) {
  const source = boundedString(raw.source || 'legacy', 'session source', 16);
  if (!SESSION_SOURCES.has(source)) throw new Error('session source is invalid.');
  const timeKind = raw.timeKind === undefined ? 'explicit' : boundedString(raw.timeKind, 'time kind', 16);
  if (!TIME_KINDS.has(timeKind)) throw new Error('time kind is invalid.');
  const start = isoTimestamp(raw.start, 'session start');
  const end = isoTimestamp(raw.end, 'session end');
  if (Date.parse(end) <= Date.parse(start)) throw new Error('session end must be after start.');
  const result = {
    id: validateEntityId(raw.id, 'session ID'),
    start,
    end,
    dayMinutes: boundedNumber(raw.dayMinutes, 'day minutes', 0, 1000000, { integer: true }),
    nightMinutes: boundedNumber(raw.nightMinutes, 'night minutes', 0, 1000000, { integer: true }),
    source,
    timeKind
  };
  const note = boundedString(raw.note, 'session note', 2000, { optional: true });
  if (note !== undefined) result.note = note;
  return result;
}

export function substantiveSessionEquals(a, b) {
  if (!a || !b) return a === b;
  return a.start === b.start &&
    a.end === b.end &&
    a.dayMinutes === b.dayMinutes &&
    a.nightMinutes === b.nightMinutes &&
    (a.note || '') === (b.note || '') &&
    a.source === b.source &&
    (a.timeKind || 'explicit') === (b.timeKind || 'explicit');
}

function normalizeSession(raw, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('session must be an object.');
  const session = copySessionFields(raw);
  const previous = context.previousById.get(session.id);
  const sameAsPrevious = substantiveSessionEquals(session, previous);
  const legacyChanged = !!previous && !sameAsPrevious;
  const fallbackCreatedAt = previous?.createdAt || context.migratedAt || context.now;
  session.createdAt = isValidIsoTimestamp(raw.createdAt)
    ? new Date(raw.createdAt).toISOString()
    : fallbackCreatedAt;
  session.updatedAt = isValidIsoTimestamp(raw.updatedAt)
    ? new Date(raw.updatedAt).toISOString()
    : (legacyChanged ? context.now : previous?.updatedAt || fallbackCreatedAt);
  session.revision = Number.isInteger(raw.revision) && raw.revision >= 1 && raw.revision <= 1000000000
    ? raw.revision
    : (legacyChanged ? (previous.revision || 0) + 1 : previous?.revision || 1);
  try {
    session.updatedBy = validateEntityId(raw.updatedBy, 'updatedBy');
  } catch {
    session.updatedBy = legacyChanged ? 'legacy' : previous?.updatedBy || context.fallbackWriter;
  }
  if (!isValidIsoTimestamp(raw.createdAt) || !isValidIsoTimestamp(raw.updatedAt) ||
      !Number.isInteger(raw.revision) || !ID_RE.test(String(raw.updatedBy || '')) ||
      raw.timeKind === undefined || raw.source === undefined) {
    context.changed = true;
    context.issues.push({
      code: legacyChanged ? 'legacy-session-change' : 'session-metadata-repair',
      entityId: session.id,
      message: legacyChanged
        ? 'A legacy client changed an entry; metadata was repaired for review.'
        : 'Entry metadata was repaired.'
    });
  }
  return session;
}

function normalizeActive(raw, context) {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('active drive must be an object.');
  const startedAt = isoTimestamp(raw.startedAt, 'active start');
  const previous = context.previousActive;
  const id = raw.id === undefined
    ? previous?.id || createId()
    : validateEntityId(raw.id, 'active ID');
  const metadataMissing = raw.id === undefined || !Number.isInteger(raw.revision) || !ID_RE.test(String(raw.updatedBy || ''));
  const sameAsPrevious = previous?.startedAt === startedAt;
  const active = {
    id,
    startedAt,
    revision: Number.isInteger(raw.revision) && raw.revision >= 1 && raw.revision <= 1000000000
      ? raw.revision
      : (sameAsPrevious ? previous?.revision || 1 : (previous?.revision || 0) + 1),
    updatedBy: ID_RE.test(String(raw.updatedBy || ''))
      ? raw.updatedBy
      : (sameAsPrevious ? previous?.updatedBy || 'legacy' : 'legacy')
  };
  if (metadataMissing) {
    context.changed = true;
    context.issues.push({
      code: 'legacy-active',
      entityId: id,
      message: 'A legacy active drive needs review before it can be changed.'
    });
    active.needsReview = true;
  }
  return active;
}

function normalizeTombstone(raw) {
  const session = copySessionFields(raw);
  session.createdAt = isoTimestamp(raw.createdAt, 'createdAt');
  session.updatedAt = isoTimestamp(raw.updatedAt, 'updatedAt');
  session.revision = boundedNumber(raw.revision, 'revision', 1, 1000000000, { integer: true });
  session.updatedBy = validateEntityId(raw.updatedBy, 'updatedBy');
  session.deletedAt = isoTimestamp(raw.deletedAt, 'deletedAt');
  session.deletedBy = validateEntityId(raw.deletedBy, 'deletedBy');
  return session;
}

function safePassthrough(raw, issues) {
  const result = createNullMap();
  let totalBytes = 0;
  for (const key of Object.keys(raw)) {
    if (KNOWN_TOP_LEVEL.has(key) || DANGEROUS_KEYS.has(key)) continue;
    try {
      const value = scrubUntrusted(raw[key]);
      const size = new Blob([JSON.stringify(value)]).size;
      if (size > 32768 || totalBytes + size > 65536) {
        issues.push({ code: 'oversized-passthrough', message: `Ignored oversized top-level field "${key}".` });
        continue;
      }
      result[key] = value;
      totalBytes += size;
    } catch {
      issues.push({ code: 'invalid-passthrough', message: `Ignored invalid top-level field "${key}".` });
    }
  }
  return result;
}

export function normalizeRemoteDocument(rawInput, options = {}) {
  const now = isValidIsoTimestamp(options.now) ? new Date(options.now).toISOString() : new Date().toISOString();
  const raw = scrubUntrusted(rawInput);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Remote logbook is not an object.');
  const driverId = boundedString(raw.driverId ?? options.driverId, 'driver ID', 64);
  if (options.driverId && driverId !== options.driverId) throw new Error('Remote logbook belongs to another driver.');
  const issues = [];
  const previous = options.previous || null;
  const legacyDocument = raw.schemaVersion === undefined;
  const migratedAt = isValidIsoTimestamp(raw.migratedAt)
    ? new Date(raw.migratedAt).toISOString()
    : (legacyDocument ? now : previous?.migratedAt || null);
  const context = {
    now,
    migratedAt,
    fallbackWriter: legacyDocument ? 'migration' : 'legacy',
    previousById: new Map((previous?.sessions || []).map((s) => [s.id, s])),
    previousActive: previous?.active || null,
    issues,
    changed: legacyDocument ||
      raw.minimumClientVersion === undefined ||
      raw.deletedSessions === undefined ||
      (raw.migratedAt === undefined && !!previous?.migratedAt)
  };
  const sessions = [];
  const sessionIds = new Set();
  const inputSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  if (!Array.isArray(raw.sessions)) issues.push({ code: 'invalid-sessions', message: 'The remote sessions list was invalid.' });
  inputSessions.forEach((entry, index) => {
    try {
      const session = normalizeSession(entry, context);
      if (sessionIds.has(session.id)) throw new Error('duplicate session ID.');
      sessionIds.add(session.id);
      sessions.push(session);
    } catch (error) {
      context.changed = true;
      issues.push({ code: 'quarantined-session', index, message: `Quarantined session ${index + 1}: ${error.message}` });
    }
  });
  const deletedSessions = [];
  const deletedIds = new Set();
  const inputDeleted = raw.deletedSessions === undefined
    ? (previous?.deletedSessions || [])
    : raw.deletedSessions;
  if (!Array.isArray(inputDeleted)) {
    context.changed = true;
    issues.push({ code: 'invalid-deletions', message: 'The remote deletion list was invalid.' });
  } else {
    inputDeleted.forEach((entry, index) => {
      try {
        const tombstone = normalizeTombstone(entry);
        if (deletedIds.has(tombstone.id)) throw new Error('duplicate deletion ID.');
        deletedIds.add(tombstone.id);
        deletedSessions.push(tombstone);
      } catch (error) {
        context.changed = true;
        issues.push({ code: 'quarantined-deletion', index, message: `Quarantined deletion ${index + 1}: ${error.message}` });
      }
    });
  }
  const liveSessions = sessions.filter((session) => {
    if (!deletedIds.has(session.id)) return true;
    context.changed = true;
    issues.push({
      code: 'quarantined-resurrection',
      entityId: session.id,
      message: 'Quarantined a live entry whose tombstone already exists.'
    });
    return false;
  });
  let active = null;
  try {
    active = normalizeActive(raw.active, context);
  } catch (error) {
    context.changed = true;
    issues.push({ code: 'quarantined-active', message: `Quarantined active drive: ${error.message}` });
  }
  const version = Number.isInteger(raw.version) && raw.version >= 0 && raw.version <= 1000000000 ? raw.version : 0;
  if (version !== raw.version) issues.push({ code: 'invalid-version', message: 'The remote version was invalid.' });
  const schemaVersion = Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 1
    ? raw.schemaVersion
    : SCHEMA_VERSION;
  if (raw.schemaVersion !== undefined && schemaVersion !== raw.schemaVersion) {
    context.changed = true;
    issues.push({ code: 'invalid-schema-version', message: 'The remote schema version was invalid.' });
  }
  const minimumClientVersion = typeof raw.minimumClientVersion === 'string' && VERSION_RE.test(raw.minimumClientVersion)
    ? raw.minimumClientVersion
    : CLIENT_VERSION;
  if (raw.minimumClientVersion !== undefined && minimumClientVersion !== raw.minimumClientVersion) {
    context.changed = true;
    issues.push({ code: 'invalid-client-version', message: 'The remote minimum client version was invalid.' });
  }
  if (raw.migratedAt !== undefined && raw.migratedAt !== null && !isValidIsoTimestamp(raw.migratedAt)) {
    context.changed = true;
    issues.push({ code: 'invalid-migration-date', message: 'The remote migration timestamp was invalid.' });
  }
  const document = {
    driverId,
    version,
    schemaVersion,
    minimumClientVersion,
    migratedAt,
    active,
    sessions: liveSessions,
    deletedSessions,
    settings: normalizeSettings(raw.settings, issues),
    passthrough: safePassthrough(raw, issues),
    quarantine: issues.filter((issue) => issue.code.startsWith('quarantined'))
  };
  return { document, issues, changed: context.changed || issues.length > 0 };
}

export function serializeRemoteDocument(document) {
  const output = createNullMap();
  for (const key of Object.keys(document.passthrough || createNullMap())) {
    if (!KNOWN_TOP_LEVEL.has(key) && !DANGEROUS_KEYS.has(key)) {
      output[key] = scrubUntrusted(document.passthrough[key]);
    }
  }
  output.driverId = document.driverId;
  output.version = document.version;
  output.schemaVersion = document.schemaVersion;
  output.minimumClientVersion = document.minimumClientVersion;
  if (document.migratedAt) output.migratedAt = document.migratedAt;
  output.active = document.active ? copyAllowedActive(document.active) : null;
  output.sessions = document.sessions.map(copyAllowedSession);
  output.deletedSessions = document.deletedSessions.map(copyAllowedTombstone);
  output.settings = normalizeSettings(document.settings);
  return output;
}

export function copyAllowedSession(session) {
  const result = copySessionFields(session);
  result.createdAt = isoTimestamp(session.createdAt, 'createdAt');
  result.updatedAt = isoTimestamp(session.updatedAt, 'updatedAt');
  result.revision = boundedNumber(session.revision, 'revision', 1, 1000000000, { integer: true });
  result.updatedBy = validateEntityId(session.updatedBy, 'updatedBy');
  return result;
}

export function copyAllowedTombstone(session) {
  const result = copyAllowedSession(session);
  result.deletedAt = isoTimestamp(session.deletedAt, 'deletedAt');
  result.deletedBy = validateEntityId(session.deletedBy, 'deletedBy');
  return result;
}

export function copyAllowedActive(active) {
  return {
    id: validateEntityId(active.id, 'active ID'),
    startedAt: isoTimestamp(active.startedAt, 'active start'),
    revision: boundedNumber(active.revision, 'active revision', 1, 1000000000, { integer: true }),
    updatedBy: validateEntityId(active.updatedBy, 'active updatedBy')
  };
}

export function entityEquals(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a == null && b == null;
  if (a.startedAt !== undefined || b.startedAt !== undefined) {
    return a.id === b.id && a.startedAt === b.startedAt &&
      a.revision === b.revision && a.updatedBy === b.updatedBy;
  }
  return a.id === b.id && substantiveSessionEquals(a, b) &&
    a.revision === b.revision && a.updatedBy === b.updatedBy;
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '_');
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const uid = createId;

export function nextRevision(base, deviceId, now = new Date().toISOString()) {
  return {
    revision: (base?.revision || 0) + 1,
    updatedBy: validateEntityId(deviceId, 'device ID'),
    updatedAt: now
  };
}

export function compareClientVersions(left, right) {
  const parse = (value) => String(value || 'v0').replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  }
  return 0;
}

export function isClientUpdateRequired(document, clientVersion = CLIENT_VERSION) {
  return compareClientVersions(clientVersion, document.minimumClientVersion) < 0 ||
    document.schemaVersion > SCHEMA_VERSION;
}

export function serializedByteLength(document) {
  return new Blob([JSON.stringify(serializeRemoteDocument(document))]).size;
}

/**
 * Split a [start, end) interval into day/night minutes.
 */
export function splitDayNight(start, end, dayStartHour, nightStartHour) {
  let dayMs = 0;
  let nightMs = 0;
  let cur = new Date(start.getTime());
  const endMs = end.getTime();
  let guard = 0;
  while (cur.getTime() < endMs && guard < 5000) {
    guard++;
    const dayStart = startOfDayPlusHours(cur, dayStartHour);
    const nightStart = startOfDayPlusHours(cur, nightStartHour);
    const isDay = cur >= dayStart && cur < nightStart;
    let nextBoundary;
    if (isDay) nextBoundary = nightStart > cur ? nightStart : addDays(nightStart, 1);
    else if (cur < dayStart) nextBoundary = dayStart > cur ? dayStart : addDays(dayStart, 1);
    else nextBoundary = addDays(dayStart, 1);
    const segmentEnd = nextBoundary.getTime() < endMs ? nextBoundary : end;
    const segMs = segmentEnd.getTime() - cur.getTime();
    if (isDay) dayMs += segMs;
    else nightMs += segMs;
    cur = segmentEnd;
  }
  return { dayMinutes: Math.round(dayMs / 60000), nightMinutes: Math.round(nightMs / 60000) };
}

function startOfDayPlusHours(date, hours) {
  const d = new Date(date.getTime());
  const totalMilliseconds = Math.round(hours * 3600000);
  const hour = Math.floor(totalMilliseconds / 3600000);
  let remainder = totalMilliseconds - hour * 3600000;
  const minute = Math.floor(remainder / 60000);
  remainder -= minute * 60000;
  const second = Math.floor(remainder / 1000);
  const millisecond = remainder - second * 1000;
  d.setHours(hour, minute, second, millisecond);
  return d;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatHoursDecimal(totalMinutes) {
  return (totalMinutes / 60).toFixed(1);
}

export function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
