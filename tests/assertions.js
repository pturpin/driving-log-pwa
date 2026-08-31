import {
  CLIENT_VERSION,
  SCHEMA_VERSION,
  emptyDocument,
  normalizeRemoteDocument,
  safeJsonParse,
  serializeRemoteDocument
} from '../js/utils.js';
import { decodeSetupCode, encodeSetupCode, validateConfig } from '../js/config.js';
import { detectSessionConflicts, sessionsOverlap } from '../js/conflicts.js';
import { classifyDirtyForSync, LogRepository, projectDocument } from '../js/log-repository.js';
import { parseBackup, previewBackup } from '../js/export.js';
import { LocalStateChangedError, LocalStore } from '../js/local-store.js';

const results = document.getElementById('results');
const summary = document.getElementById('summary');
let passed = 0;
let failed = 0;

function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new Error(message);
}

async function test(name, callback) {
  const row = document.createElement('li');
  try {
    await callback();
    row.className = 'pass';
    row.textContent = `PASS — ${name}`;
    passed++;
  } catch (error) {
    row.className = 'fail';
    row.textContent = `FAIL — ${name}: ${error.message}`;
    failed++;
  }
  results.appendChild(row);
}

function session(id, start, end, extra = {}) {
  return {
    id,
    start,
    end,
    dayMinutes: 60,
    nightMinutes: 0,
    source: 'manual',
    timeKind: 'explicit',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    updatedBy: 'device_a',
    ...extra
  };
}

await test('legacy migration adds schema metadata without dropping sessions', () => {
  const legacy = {
    driverId: 'Jamie',
    version: 4,
    sessions: [{ id: 's1', start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z', dayMinutes: 60, nightMinutes: 0, source: 'manual' }],
    active: null,
    settings: {}
  };
  const result = normalizeRemoteDocument(legacy, { driverId: 'Jamie', now: '2026-02-01T00:00:00Z' });
  assert(result.document.schemaVersion === SCHEMA_VERSION);
  assert(result.document.sessions[0].createdAt === '2026-02-01T00:00:00.000Z');
  assert(result.document.sessions[0].updatedBy === 'migration');
  assert(result.changed);
});

await test('stale legacy edit mints a new revision and preserves deletions', () => {
  const previous = emptyDocument('Jamie');
  previous.migratedAt = '2026-01-01T00:00:00.000Z';
  previous.sessions = [session('s1', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z')];
  previous.deletedSessions = [{
    ...session('gone', '2025-01-01T10:00:00Z', '2025-01-01T11:00:00Z'),
    deletedAt: '2026-01-03T00:00:00.000Z',
    deletedBy: 'device_a'
  }];
  const raw = serializeRemoteDocument(previous);
  raw.sessions[0].note = 'changed by old client';
  delete raw.sessions[0].revision;
  delete raw.sessions[0].updatedBy;
  const result = normalizeRemoteDocument(raw, { driverId: 'Jamie', previous, now: '2026-02-01T00:00:00Z' });
  assert(result.document.sessions[0].revision === 2);
  assert(result.document.sessions[0].updatedBy === 'legacy');
  assert(result.document.deletedSessions.length === 1);
});

await test('missing tombstone storage is repaired and stale resurrection is quarantined', () => {
  const previous = emptyDocument('Jamie');
  previous.migratedAt = '2026-01-01T00:00:00.000Z';
  const deleted = {
    ...session('gone', '2025-01-01T10:00:00Z', '2025-01-01T11:00:00Z'),
    deletedAt: '2026-01-03T00:00:00.000Z',
    deletedBy: 'device_a'
  };
  previous.deletedSessions = [deleted];
  const raw = serializeRemoteDocument(previous);
  delete raw.deletedSessions;
  raw.sessions = [session('gone', '2025-01-01T10:00:00Z', '2025-01-01T11:00:00Z')];
  const result = normalizeRemoteDocument(raw, { driverId: 'Jamie', previous });
  assert(result.document.deletedSessions.length === 1);
  assert(result.document.sessions.length === 0);
  assert(result.document.quarantine.some((issue) => issue.code === 'quarantined-resurrection'));
});

await test('prototype keys and invalid records are quarantined', () => {
  const parsed = safeJsonParse('{"driverId":"Jamie","version":1,"schemaVersion":2,"minimumClientVersion":"v0.15","sessions":[{"id":"<img>"}],"deletedSessions":[],"active":null,"settings":{},"__proto__":{"polluted":true}}');
  const result = normalizeRemoteDocument(parsed, { driverId: 'Jamie' });
  assert(result.document.sessions.length === 0);
  assert(result.document.quarantine.length === 1);
  assert({}.polluted === undefined);
});

await test('automatic repair is limited to lossless metadata migration', async () => {
  const { isLosslessAutomaticRepair } = await import('../js/dynamo.js');
  const legacy = {
    driverId: 'Jamie',
    version: 1,
    active: null,
    sessions: [{
      id: 's1',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z',
      dayMinutes: 60,
      nightMinutes: 0,
      source: 'manual'
    }],
    settings: emptyDocument('Jamie').settings
  };
  assert(isLosslessAutomaticRepair(normalizeRemoteDocument(legacy, { driverId: 'Jamie' })));

  const invalidCollection = {
    ...legacy,
    schemaVersion: SCHEMA_VERSION,
    minimumClientVersion: CLIENT_VERSION,
    deletedSessions: [],
    sessions: { bad: true }
  };
  const normalized = normalizeRemoteDocument(invalidCollection, { driverId: 'Jamie' });
  assert(normalized.issues.some((issue) => issue.code === 'invalid-sessions'));
  assert(!isLosslessAutomaticRepair(normalized));

  const quarantined = {
    ...invalidCollection,
    sessions: [{ id: '<invalid>' }]
  };
  assert(!isLosslessAutomaticRepair(normalizeRemoteDocument(quarantined, { driverId: 'Jamie' })));
});

await test('setup code validates every bearer-capability field', () => {
  const valid = {
    region: 'us-east-1',
    idp: 'us-east-1:12345678-1234-1234-1234-123456789abc',
    table: 'DrivingLog',
    driver: 'Jamie'
  };
  assert(decodeSetupCode(encodeSetupCode(valid)).table === valid.table);
  let rejected = false;
  try {
    validateConfig({ ...valid, table: 'x<script>' });
  } catch {
    rejected = true;
  }
  assert(rejected);
});

await test('overlap is strict and duration entries are excluded', () => {
  const a = session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
  const touching = session('b', '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z');
  const duration = session('c', '2026-01-01T10:30:00Z', '2026-01-01T11:30:00Z', { timeKind: 'duration' });
  assert(!sessionsOverlap(a, touching));
  assert(!sessionsOverlap(a, duration));
});

await test('duplicate precedence and migration baseline acknowledgement', () => {
  const a = session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
  const b = session('b', '2026-01-01T10:04:00Z', '2026-01-01T11:05:00Z');
  const groups = detectSessionConflicts([a, b], { migratedAt: '2026-02-01T00:00:00Z' });
  assert(groups.length === 1);
  assert(groups[0].type === 'duplicate');
  assert(groups[0].acknowledged && groups[0].migrationBaseline);
});

await test('derived acknowledgement changes when conflict type or member content changes', () => {
  const a = session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
  const b = session('b', '2026-01-01T10:04:00Z', '2026-01-01T11:05:00Z');
  const original = detectSessionConflicts([a, b])[0];
  const acknowledgements = new Set([original.id]);
  assert(detectSessionConflicts([a, b], { acknowledgements })[0].acknowledged);

  const revisedDuplicate = {
    ...b,
    note: 'edited while still a duplicate',
    revision: 2,
    updatedAt: '2026-01-02T00:00:00.000Z'
  };
  const revised = detectSessionConflicts([a, revisedDuplicate], { acknowledgements })[0];
  assert(revised.type === 'duplicate');
  assert(revised.id !== original.id);
  assert(!revised.acknowledged, 'edited duplicate content must require a fresh acknowledgement');

  const edited = {
    ...b,
    start: '2026-01-01T10:20:00Z',
    end: '2026-01-01T11:20:00Z',
    revision: 2,
    updatedAt: '2026-01-02T00:00:00.000Z'
  };
  const changed = detectSessionConflicts([a, edited], { acknowledgements })[0];
  assert(changed.type === 'overlap');
  assert(changed.id !== original.id);
  assert(!changed.acknowledged, 'an edited overlap must require a fresh acknowledgement');
});

await test('dirty projection overlays create, edit, delete, and active state', () => {
  const base = emptyDocument('Jamie');
  base.sessions = [session('old', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')];
  const created = session('new', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z');
  const projected = projectDocument(base, [
    { kind: 'session', entityId: 'old', local: null, tombstone: { ...base.sessions[0], deletedAt: '2026-01-03T00:00:00Z', deletedBy: 'device_a' } },
    { kind: 'session', entityId: 'new', local: created },
    { kind: 'active', entityId: 'active', local: { id: 'act', startedAt: '2026-01-04T00:00:00Z', revision: 1, updatedBy: 'device_a' } }
  ]);
  assert(projected.sessions.length === 1 && projected.sessions[0].id === 'new');
  assert(projected.deletedSessions[0].id === 'old');
  assert(projected.active.id === 'act');
});

await test('IndexedDB dirty state survives reopen and repeated edits coalesce', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const first = new LocalStore(scope);
  const doc = emptyDocument(scope);
  await first.saveSnapshot(doc);
  const original = await first.putDirty({
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a'),
    sequence: 1,
    changedAt: '2026-01-01T00:00:00.000Z'
  });
  await first.putDirty({
    ...original,
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a', undefined, undefined, { note: 'second edit' }),
    sequence: 1,
    changedAt: '2026-01-01T00:01:00.000Z'
  });
  const reopened = new LocalStore(scope);
  const dirty = await reopened.listDirty();
  assert(dirty.length === 1);
  assert(dirty[0].local.note === 'second edit');
  assert((await reopened.latestSnapshot()).driverId === scope);
});

await test('IndexedDB compare-and-swap preserves a newer tab edit', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const first = new LocalStore(scope);
  const second = new LocalStore(scope);
  const original = await first.putDirty({
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a'),
    sequence: 1,
    changedAt: '2026-01-01T00:00:00.000Z'
  });
  const stale = (await second.listDirty())[0];
  const newer = await second.putDirty({
    ...stale,
    local: session('a', undefined, undefined, { note: 'newer tab edit' }),
    changedAt: '2026-01-01T00:01:00.000Z'
  });
  let updateRejected = false;
  try {
    await first.putDirty({
      ...original,
      local: session('a', undefined, undefined, { note: 'stale tab edit' }),
      changedAt: '2026-01-01T00:02:00.000Z'
    });
  } catch (error) {
    updateRejected = error instanceof LocalStateChangedError;
  }
  assert(updateRejected, 'a stale tab must not replace a newer dirty record');
  let rejected = false;
  try {
    await first.deleteDirty([original]);
  } catch (error) {
    rejected = error instanceof LocalStateChangedError;
  }
  assert(rejected, 'a stale tab must not confirm and delete a newer dirty record');
  const retained = await first.listDirty();
  assert(retained.length === 1 && retained[0].writeId === newer.writeId);
  assert(retained[0].local.note === 'newer tab edit');
});

await test('full restore compare-and-clear preserves newer cross-tab operational state', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const first = new LocalStore(scope);
  const second = new LocalStore(scope);
  const expected = await first.operationalState();
  await second.putDirty({
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a'),
    sequence: 1,
    changedAt: '2026-01-01T00:00:00.000Z'
  });
  await second.putConflicts([{
    id: 'technical_a',
    type: 'technical',
    entityKeys: ['session:a']
  }]);
  let rejected = false;
  try {
    await first.clearOperationalStateAndSave(emptyDocument(scope), expected.revision);
  } catch (error) {
    rejected = error instanceof LocalStateChangedError;
  }
  assert(rejected, 'restore must refuse to clear state changed by another tab');
  const retained = await first.operationalState();
  assert(retained.dirty.length === 1 && retained.conflicts.length === 1);
});

await test('full restore retains recovery history and clears only operational state', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const store = new LocalStore(scope);
  for (let version = 1; version <= 5; version++) {
    const snapshot = emptyDocument(scope);
    snapshot.version = version;
    await store.saveSnapshot(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await store.putDirty({
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a'),
    sequence: 1,
    changedAt: '2026-01-01T00:00:00.000Z'
  });
  await store.putConflicts([{ id: 'technical_a', type: 'technical', entityKeys: ['session:a'] }]);
  await store.acknowledge('derived_a');
  const expected = await store.operationalState();
  const restored = emptyDocument(scope);
  restored.version = 99;

  await store.clearOperationalStateAndSave(restored, expected.revision);

  const history = await store.snapshotHistory();
  const operational = await store.operationalState();
  assert(history.length === 5, 'normal recovery retention must remain at five snapshots');
  assert(history.some((entry) => entry.version === 99), 'restored document must be appended');
  assert(history.filter((entry) => entry.version !== 99).length === 4, 'four prior recovery points must remain');
  assert(operational.dirty.length === 0 && operational.conflicts.length === 0);
  assert(operational.acknowledgements.size === 0);
});

await test('cancelling an unsynced merged output reverses its entire atomic group', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: scope };
  repository.store = new LocalStore(scope);
  repository.snapshot = emptyDocument(scope);
  repository.snapshot.sessions = [
    session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
    session('b', '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z')
  ];
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';

  await repository.mergeSessions(
    session('merged', '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
    ['a', 'b']
  );
  assert(repository.dirty.length === 3);
  await repository.deleteSession('merged');
  assert(repository.dirty.length === 0);
  assert((await repository.store.listDirty()).length === 0);
  assert(repository.effectiveDocument().sessions.map((entry) => entry.id).sort().join(',') === 'a,b');
});

await test('cancelling an ordinary unsynced create removes only that create', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: scope };
  repository.store = new LocalStore(scope);
  repository.snapshot = emptyDocument(scope);
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';

  await repository.saveSession(
    session('created', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')
  );
  await repository.deleteSession('created');
  assert(repository.dirty.length === 0);
  assert((await repository.store.listDirty()).length === 0);
});

await test('deleting an uncertain create retains a tombstone intent', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: scope };
  repository.store = new LocalStore(scope);
  repository.snapshot = emptyDocument(scope);
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';
  const created = session('created', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
  const dirty = await repository.store.putDirty({
    entityKey: 'session:created',
    entityId: 'created',
    kind: 'session',
    base: null,
    baseTombstone: null,
    local: created,
    tombstone: null,
    uncertainAttempt: { attemptedAt: '2026-01-02T00:00:00.000Z', local: created, tombstone: null },
    groupId: null,
    sequence: 1,
    changedAt: '2026-01-01T00:00:00.000Z'
  });
  repository.dirty = [dirty];

  await repository.deleteSession('created');

  assert(repository.dirty.length === 1 && repository.dirty[0].local === null);
  assert(repository.dirty[0].tombstone.revision === created.revision + 1);
  const remote = emptyDocument(scope);
  remote.sessions = [created];
  const classification = classifyDirtyForSync(remote, repository.dirty, repository.deviceId);
  assert(classification.eligible.length === 1 && classification.blocked.length === 0);
});

await test('deleting an uncertain atomic merge tombstones output and restores sources', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: scope };
  repository.store = new LocalStore(scope);
  repository.snapshot = emptyDocument(scope);
  repository.snapshot.sessions = [
    session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
    session('b', '2026-01-01T11:00:00Z', '2026-01-01T12:00:00Z')
  ];
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';

  await repository.mergeSessions(
    session('merged', '2026-01-01T10:00:00Z', '2026-01-01T12:00:00Z'),
    ['a', 'b']
  );
  const attempted = await repository.store.putDirtyMany(repository.dirty.map((record) => ({
    ...record,
    uncertainAttempt: {
      attemptedAt: '2026-01-02T00:00:00.000Z',
      local: record.local ? { ...record.local } : null,
      tombstone: record.tombstone ? { ...record.tombstone } : null
    }
  })));
  repository.dirty = attempted;
  const landed = projectDocument(repository.snapshot, attempted);

  await repository.deleteSession('merged');

  const merged = repository.dirty.find((record) => record.entityId === 'merged');
  const restoredSources = repository.dirty.filter((record) => record.entityId !== 'merged');
  assert(merged.local === null && merged.tombstone.revision === 2);
  assert(restoredSources.every((record) => record.local && record.tombstone === null));
  assert(repository.effectiveDocument().sessions.map((entry) => entry.id).sort().join(',') === 'a,b');
  const classification = classifyDirtyForSync(landed, repository.dirty, repository.deviceId);
  assert(classification.eligible.length === 3 && classification.blocked.length === 0);
});

await test('rebase allows disjoint edits and blocks an atomic group together', () => {
  const base = emptyDocument('Jamie');
  base.sessions = [session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')];
  const edit = { ...base.sessions[0], note: 'local', revision: 2, updatedBy: 'device_a' };
  const disjoint = classifyDirtyForSync(base, [{
    entityKey: 'session:a', entityId: 'a', kind: 'session', base: base.sessions[0], local: edit, groupId: null
  }], 'device_a');
  assert(disjoint.eligible.length === 1);
  const changedRemote = emptyDocument('Jamie');
  changedRemote.sessions = [{ ...base.sessions[0], note: 'remote', revision: 2, updatedBy: 'device_b' }];
  const grouped = classifyDirtyForSync(changedRemote, [
    { entityKey: 'session:a', entityId: 'a', kind: 'session', base: base.sessions[0], local: edit, groupId: 'g1' },
    { entityKey: 'active', entityId: 'active', kind: 'active', base: null, local: null, groupId: 'g1' }
  ], 'device_a');
  assert(grouped.eligible.length === 0);
  assert(grouped.blocked.length === 1 && grouped.blocked[0].records.length === 2);
});

await test('uncertain writes require positive device authorship, not version coincidence', () => {
  const remote = emptyDocument('Jamie');
  const local = session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', { updatedBy: 'device_a' });
  remote.sessions = [{ ...local, updatedBy: 'device_a' }];
  const dirty = [{ entityKey: 'session:a', entityId: 'a', kind: 'session', base: null, local, groupId: null }];
  assert(classifyDirtyForSync(remote, dirty, 'device_a').appliedKeys.length === 1);
  remote.sessions[0].updatedBy = 'device_b';
  const notAuthored = classifyDirtyForSync(remote, dirty, 'device_a');
  assert(notAuthored.appliedKeys.length === 0 && notAuthored.blocked.length === 1);
});

await test('keep local safely resurrects an entry deleted remotely', async () => {
  const scope = `test_${crypto.randomUUID().replace(/-/g, '_')}`;
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: scope };
  repository.store = new LocalStore(scope);
  repository.snapshot = emptyDocument(scope);
  const base = session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z');
  const tombstone = {
    ...base,
    revision: 2,
    updatedAt: '2026-01-02T00:00:00.000Z',
    updatedBy: 'device_b',
    deletedAt: '2026-01-02T00:00:00.000Z',
    deletedBy: 'device_b'
  };
  repository.snapshot.deletedSessions = [tombstone];
  const dirty = await repository.store.putDirty({
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base,
    baseTombstone: null,
    local: {
      ...base,
      note: 'keep this edit',
      revision: 2,
      updatedAt: '2026-01-03T00:00:00.000Z',
      updatedBy: 'device_a'
    },
    tombstone: null,
    groupId: null,
    sequence: 1,
    changedAt: '2026-01-03T00:00:00.000Z'
  });
  repository.dirty = [dirty];
  repository.technicalConflicts = [{
    id: 'technical_session_a',
    type: 'technical',
    entityKeys: ['session:a']
  }];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'attention';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';

  await repository.resolveTechnicalConflict('technical_session_a', 'local');

  assert(repository.dirty.length === 1);
  assert(repository.dirty[0].baseTombstone.deletedAt === tombstone.deletedAt);
  assert(repository.dirty[0].local.revision === tombstone.revision + 1);
  const classification = classifyDirtyForSync(repository.snapshot, repository.dirty, repository.deviceId);
  assert(classification.eligible.length === 1 && classification.blocked.length === 0);
});

await test('backup parsing validates and previews without replacing unnamed entries', () => {
  const current = emptyDocument('Jamie');
  current.sessions = [session('a', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')];
  const backup = {
    backupVersion: 2,
    schemaVersion: SCHEMA_VERSION,
    minimumClientVersion: CLIENT_VERSION,
    driverId: 'Jamie',
    exportedAt: '2026-03-01T00:00:00Z',
    sessions: [session('b', '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z')],
    deletedSessions: [],
    active: null,
    settings: current.settings
  };
  const parsed = parseBackup(JSON.stringify(backup), 'Jamie');
  const preview = previewBackup(current, parsed.document);
  assert(preview.creates === 1 && preview.deletions === 0);
});

await test('future-schema backups are rejected before preview, import, or full restore', async () => {
  const current = emptyDocument('Jamie');
  const future = {
    ...current,
    schemaVersion: SCHEMA_VERSION + 1,
    minimumClientVersion: 'v999.0'
  };
  const backup = {
    backupVersion: 2,
    schemaVersion: future.schemaVersion,
    minimumClientVersion: future.minimumClientVersion,
    driverId: 'Jamie',
    exportedAt: '2026-03-01T00:00:00Z',
    sessions: [],
    deletedSessions: [],
    active: null,
    settings: current.settings
  };
  let parseRejected = false;
  let previewRejected = false;
  try {
    parseBackup(JSON.stringify(backup), 'Jamie');
  } catch (error) {
    parseRejected = /newer app/.test(error.message);
  }
  try {
    previewBackup(current, future);
  } catch (error) {
    previewRejected = /newer app/.test(error.message);
  }
  assert(parseRejected && previewRejected);

  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: 'Jamie' };
  repository.snapshot = current;
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.deviceId = 'device_a';
  let importRejected = false;
  let restoreRejected = false;
  try {
    await repository.importBackup(future);
  } catch (error) {
    importRejected = /newer app/.test(error.message);
  }
  try {
    await repository.fullRestore(future);
  } catch (error) {
    restoreRejected = /newer app/.test(error.message);
  }
  assert(importRejected && restoreRejected);
});

await test('unsafe remote normalization blocks repository writes', async () => {
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: 'Jamie' };
  repository.snapshot = emptyDocument('Jamie');
  repository.dirty = [{
    entityKey: 'session:a',
    entityId: 'a',
    kind: 'session',
    base: null,
    local: session('a'),
    tombstone: null,
    groupId: null,
    sequence: 1,
    writeId: 'write_a'
  }];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';
  repository.storagePersisted = true;
  let writeCalled = false;
  repository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [{ code: 'invalid-sessions', message: 'The remote sessions list was invalid.' }],
      repairBlocked: true
    }),
    writeItem: async () => {
      writeCalled = true;
    }
  });
  repository.store = {
    saveSnapshot: async () => {},
    putConflicts: async () => {}
  };

  await repository.runSync();

  assert(!writeCalled, 'pending changes must not overwrite remote quarantined data');
  assert(repository.status === 'attention');
  assert(repository.technicalConflicts.some((conflict) => conflict.code === 'invalid-sessions'));
});

await test('unsafe remote normalization blocks settings writes', async () => {
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: 'Jamie' };
  repository.snapshot = emptyDocument('Jamie');
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.status = 'offline';
  repository.lastError = '';
  repository.lastSyncAt = null;
  repository.deviceId = 'device_a';
  repository.storagePersisted = true;
  let writeCalled = false;
  repository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [{ code: 'invalid-settings', message: 'The remote settings were invalid.' }],
      repairBlocked: true
    }),
    writeItem: async () => {
      writeCalled = true;
    }
  });
  repository.store = {
    saveSnapshot: async () => {},
    putConflicts: async () => {}
  };

  let rejected = false;
  try {
    await repository.updateSettings({ theme: 'dark' });
  } catch (error) {
    rejected = /Remote data needs review/.test(error.message);
  }

  assert(rejected, 'settings update must reject quarantined remote data');
  assert(!writeCalled, 'settings must not overwrite remote quarantined data');
  assert(repository.status === 'attention');
  assert(repository.technicalConflicts.some((conflict) => conflict.code === 'invalid-settings'));
});

await test('snapshot recovery handler is available at app module scope', async () => {
  const source = await (await fetch('../js/app.js')).text();
  assert(
    /^async function recoverSnapshot\(\) \{/m.test(source),
    'recoverSnapshot must be declared at module scope for event wiring'
  );
});

await test('full restore preserves the missing-item create condition', async () => {
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: 'Jamie' };
  repository.snapshot = emptyDocument('Jamie');
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.lastError = '';
  repository.status = 'offline';
  let expectedExists = null;
  repository.loadAdapter = async () => ({
    readItem: async () => ({ document: emptyDocument('Jamie'), exists: false }),
    writeItem: async (_config, document, _version, exists) => {
      expectedExists = exists;
      return { ...document, version: 1 };
    }
  });
  repository.store = {
    latestSnapshot: async () => repository.snapshot,
    operationalState: async () => ({
      revision: 0,
      dirty: [],
      conflicts: [],
      acknowledgements: new Set()
    }),
    clearOperationalStateAndSave: async (_document, revision) => {
      assert(revision === 0);
    }
  };

  await repository.runFullRestore(emptyDocument('Jamie'));

  assert(expectedExists === false, 'full restore must conditionally create when the item is absent');
});

await test('full restore rejects a fresh remote update requirement before writing', async () => {
  const repository = Object.create(LogRepository.prototype);
  repository.config = { driver: 'Jamie' };
  repository.snapshot = emptyDocument('Jamie');
  repository.dirty = [];
  repository.technicalConflicts = [];
  repository.derivedConflicts = [];
  repository.acknowledgements = new Set();
  repository.listeners = new Set();
  repository.lastError = '';
  repository.status = 'offline';
  let writeCalled = false;
  const newer = { ...emptyDocument('Jamie'), minimumClientVersion: 'v999.0' };
  repository.loadAdapter = async () => ({
    readItem: async () => ({ document: newer, exists: true }),
    writeItem: async () => {
      writeCalled = true;
    }
  });
  repository.store = {
    latestSnapshot: async () => repository.snapshot,
    operationalState: async () => ({
      revision: 0,
      dirty: [],
      conflicts: [],
      acknowledgements: new Set()
    }),
    saveSnapshot: async () => {},
    clearOperationalStateAndSave: async () => {
      throw new Error('restore state must not be cleared');
    }
  };

  let rejected = false;
  try {
    await repository.runFullRestore(emptyDocument('Jamie'));
  } catch (error) {
    rejected = /Update required/.test(error.message);
  }
  assert(rejected);
  assert(!writeCalled, 'restore must reject before composing or writing the candidate');
});

await test('DOM text rendering keeps hostile notes inert', () => {
  const host = document.createElement('div');
  host.textContent = '<img src=x onerror=alert(1)>';
  assert(host.childElementCount === 0);
  assert(host.textContent.startsWith('<img'));
});

await test('vendored SDK hash, closure, and service-worker precache are exact', async () => {
  const [bundleResponse, manifestResponse, swResponse] = await Promise.all([
    fetch('../js/vendor/aws-sdk.js'),
    fetch('../js/vendor/MANIFEST.md'),
    fetch('../sw.js')
  ]);
  const bundle = await bundleResponse.arrayBuffer();
  const manifest = await manifestResponse.text();
  const sw = await swResponse.text();
  const hashBytes = await crypto.subtle.digest('SHA-256', bundle);
  const hash = [...new Uint8Array(hashBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert(manifest.includes(hash), 'bundle hash is absent from MANIFEST.md');
  const source = new TextDecoder().decode(bundle);
  assert(!/\bimport\s*\(/.test(source), 'dynamic dependency import remains in vendor bundle');
  assert(
    !/(?:^|[;\n}])\s*import\s+(?:[^"'`;]+\s+from\s+)?["'][^"']+["']/m.test(source),
    'static import specifier remains in vendor bundle'
  );
  assert(
    !/\bexport\s+(?:[^"'`;]+\s+from\s+)?["'][^"']+["']/.test(source),
    're-export specifier remains in vendor bundle'
  );
  assert(
    !/\brequire\s*\(\s*["'][^"']+["']\s*\)/.test(source),
    'CommonJS dependency load remains in vendor bundle'
  );
  assert(sw.includes("'./js/vendor/aws-sdk.js'"), 'vendor bundle is not explicitly precached');
  if ('serviceWorker' in navigator && 'caches' in window) {
    await navigator.serviceWorker.register('../sw.js', { scope: '../', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    const version = (await (await fetch('../version.json', { cache: 'no-store' })).json()).version;
    const cache = await caches.open(`drivelog-shell-${version}`);
    const block = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/)?.[1] || '';
    const assets = [...block.matchAll(/'(\.\/[^']+)'/g)].map((match) => match[1]);
    assert(assets.length >= 10, 'could not parse shell asset list');
    for (const asset of assets) {
      const response = await cache.match(new URL(`../${asset.slice(2)}`, location.href));
      assert(response, `${asset} is missing from the active shell cache`);
    }
  }
});

summary.textContent = `${passed} passed, ${failed} failed.`;
if (failed) document.title = `FAILED (${failed}) — Driving Log assertions`;
