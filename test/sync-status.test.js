import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { LogRepository } from '../js/log-repository.js';
import {
  defaultSettings,
  emptyDocument,
  formatSharedLogbookAge
} from '../js/utils.js';

const NOW = Date.parse('2026-10-08T22:35:22.000Z');

const originalNavigator = globalThis.navigator;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    onLine: true,
    storage: {
      persisted: async () => false
    }
  }
});

test.after(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator
  });
});

function repositoryState(driver = 'Jamie') {
  const repository = Object.create(LogRepository.prototype);
  Object.assign(repository, {
    config: { driver },
    snapshot: emptyDocument(driver),
    dirty: [],
    technicalConflicts: [],
    derivedConflicts: [],
    acknowledgements: new Set(),
    listeners: new Set(),
    syncPromise: null,
    status: 'offline',
    lastError: '',
    freshnessWarning: '',
    lastSyncAt: null,
    hasConfirmedSyncThisSession: false,
    deviceId: 'device_a',
    storagePersisted: true,
    externalReloadPromise: null,
    unsubscribeStoreChanges: null
  });
  return repository;
}

test('formats shared-logbook age without producing a countdown', () => {
  assert.equal(formatSharedLogbookAge(null, NOW), 'Shared logbook not checked yet');
  assert.equal(formatSharedLogbookAge('not-a-date', NOW), 'Shared logbook not checked yet');
  assert.equal(
    formatSharedLogbookAge('2026-10-08T22:35:23.000Z', NOW),
    'Shared logbook not checked yet'
  );
  assert.equal(
    formatSharedLogbookAge('2026-10-08T22:35:20.000Z', NOW),
    'Shared logbook checked just now'
  );
  assert.equal(
    formatSharedLogbookAge('2026-10-08T22:35:04.000Z', NOW),
    'Shared logbook checked 18 seconds ago'
  );
  assert.equal(
    formatSharedLogbookAge('2026-10-08T22:34:22.000Z', NOW),
    'Shared logbook checked 1 minute ago'
  );
  assert.equal(
    formatSharedLogbookAge('2026-10-08T20:35:22.000Z', NOW),
    'Shared logbook checked 2 hours ago'
  );
  assert.equal(
    formatSharedLogbookAge('2026-10-06T22:35:22.000Z', NOW),
    'Shared logbook checked 2 days ago'
  );
});

test('restores only valid past check times without claiming a current-session sync', async () => {
  const restoredAt = '2020-10-08T20:00:00.000Z';
  const repository = repositoryState();
  repository.store = {
    getMetadata: async (name) => name === 'installationId' ? 'device_a' : restoredAt,
    setMetadata: async () => {},
    subscribeChanges: () => () => {}
  };
  repository.reloadLocalState = async () => {
    repository.snapshot = emptyDocument('Jamie');
    repository.dirty = [];
    repository.technicalConflicts = [];
    repository.acknowledgements = new Set();
  };

  const state = await repository.init();

  assert.equal(state.lastSyncAt, restoredAt);
  assert.notEqual(state.status, 'synced');
  assert.equal(repository.hasConfirmedSyncThisSession, false);

  repository.status = 'offline';
  repository.store.getMetadata = async (name) =>
    name === 'installationId' ? 'device_a' : 'invalid stored value';
  await repository.init();
  assert.equal(repository.lastSyncAt, null);
  assert.notEqual(repository.status, 'synced');
});

test('successful sync checks and settings and restore writes persist freshness', async () => {
  const persisted = [];
  const makeStore = () => ({
    saveSnapshot: async () => {},
    setMetadata: async (name, value) => persisted.push({ name, value }),
    putConflicts: async () => {},
    clearOperationalStateAndSave: async () => {}
  });

  const syncRepository = repositoryState();
  syncRepository.store = makeStore();
  syncRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: false
    })
  });
  await syncRepository.runSync();
  assert.equal(syncRepository.status, 'synced');
  assert.equal(syncRepository.hasConfirmedSyncThisSession, true);

  const settingsRepository = repositoryState();
  settingsRepository.store = makeStore();
  settingsRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: false
    }),
    writeItem: async (_config, document) => ({ ...document, version: 1 })
  });
  await settingsRepository.runSettingsUpdate(defaultSettings());
  assert.equal(settingsRepository.hasConfirmedSyncThisSession, true);

  const restoreRepository = repositoryState();
  restoreRepository.store = makeStore();
  restoreRepository.reloadLocalState = async () => ({
    dirty: [],
    conflicts: [],
    acknowledgements: new Set(),
    revision: 1
  });
  restoreRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true
    }),
    writeItem: async (_config, document) => ({ ...document, version: 1 })
  });
  await restoreRepository.runFullRestore(emptyDocument('Jamie'));
  assert.equal(restoreRepository.hasConfirmedSyncThisSession, true);

  assert.equal(persisted.length, 3);
  assert(persisted.every(({ name, value }) =>
    name === 'lastSyncAt' && Number.isFinite(Date.parse(value))
  ));
});

test('metadata persistence failure warns without invalidating successful remote operations', async () => {
  const metadataError = new Error('metadata unavailable');
  const makeStore = () => ({
    saveSnapshot: async () => {},
    setMetadata: async () => {
      throw metadataError;
    },
    putDirtyMany: async (records) => records,
    putConflicts: async () => {},
    clearOperationalStateAndSave: async () => {}
  });

  const syncRepository = repositoryState();
  syncRepository.dirty = [{
    kind: 'session',
    entityKey: 'session:session_a',
    entityId: 'session_a',
    local: {
      id: 'session_a',
      start: '2026-10-08T20:00:00.000Z',
      end: '2026-10-08T20:30:00.000Z',
      dayMinutes: 30,
      nightMinutes: 0,
      source: 'manual',
      timeKind: 'explicit',
      createdAt: '2026-10-08T20:30:00.000Z',
      updatedAt: '2026-10-08T20:30:00.000Z',
      revision: 1,
      updatedBy: 'device_a'
    },
    base: null,
    baseTombstone: null,
    tombstone: null,
    uncertainAttempt: null,
    writeId: 'write_a',
    groupId: null,
    sequence: 1,
    changedAt: '2026-10-08T20:30:00.000Z'
  }];
  syncRepository.store = makeStore();
  let syncWriteCompleted = false;
  syncRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: false
    }),
    writeItem: async (_config, document) => {
      syncWriteCompleted = true;
      return { ...document, version: 1 };
    },
    ConditionalWriteError: class extends Error {}
  });
  const syncState = await syncRepository.runSync();
  assert.equal(syncWriteCompleted, true);
  assert.equal(syncState.status, 'synced');
  assert.equal(syncState.dirtyCount, 0);
  assert.equal(syncState.lastError, '');
  assert.match(syncState.freshnessWarning, /could not save the check time/);
  assert.equal(syncRepository.hasConfirmedSyncThisSession, true);

  const settingsRepository = repositoryState();
  settingsRepository.store = makeStore();
  settingsRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: false
    }),
    writeItem: async (_config, document) => ({ ...document, version: 1 })
  });
  const settings = await settingsRepository.runSettingsUpdate(defaultSettings());
  assert.deepEqual(settings, defaultSettings());
  assert.equal(settingsRepository.status, 'synced');
  assert.equal(settingsRepository.lastError, '');
  assert.match(settingsRepository.freshnessWarning, /could not save the check time/);

  const restoreRepository = repositoryState();
  restoreRepository.store = makeStore();
  restoreRepository.reloadLocalState = async () => ({
    dirty: [],
    conflicts: [],
    acknowledgements: new Set(),
    revision: 1
  });
  restoreRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true
    }),
    writeItem: async (_config, document) => ({ ...document, version: 1 })
  });
  await restoreRepository.runFullRestore(emptyDocument('Jamie'));
  assert.equal(restoreRepository.status, 'synced');
  assert.equal(restoreRepository.lastError, '');
  assert.match(restoreRepository.freshnessWarning, /could not save the check time/);
});

test('successful reads update freshness before update-required and repair-blocked exits', async () => {
  const updateRequired = emptyDocument('Jamie');
  updateRequired.minimumClientVersion = '999.0.0';
  const updateRepository = repositoryState();
  updateRepository.store = {
    saveSnapshot: async () => {},
    setMetadata: async () => {},
    putConflicts: async () => {}
  };
  updateRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: updateRequired,
      exists: true,
      issues: [],
      repairBlocked: false
    })
  });

  const updateState = await updateRepository.runSync();
  assert.equal(updateState.status, 'attention');
  assert.equal(updateState.updateRequired, true);
  assert.equal(updateRepository.hasConfirmedSyncThisSession, true);
  assert(Number.isFinite(Date.parse(updateState.lastSyncAt)));

  const repairRepository = repositoryState();
  repairRepository.store = {
    saveSnapshot: async () => {},
    setMetadata: async () => {},
    putConflicts: async () => {}
  };
  repairRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: true
    })
  });

  const repairState = await repairRepository.runSync();
  assert.equal(repairState.status, 'attention');
  assert.match(repairState.lastError, /needs review/);
  assert.equal(repairRepository.hasConfirmedSyncThisSession, true);
  assert(Number.isFinite(Date.parse(repairState.lastSyncAt)));

  const settingsRepository = repositoryState();
  settingsRepository.store = {
    saveSnapshot: async () => {},
    setMetadata: async () => {},
    putConflicts: async () => {}
  };
  settingsRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: emptyDocument('Jamie'),
      exists: true,
      issues: [],
      repairBlocked: true
    })
  });

  await assert.rejects(
    settingsRepository.runSettingsUpdate(defaultSettings()),
    /needs review/
  );
  assert.equal(settingsRepository.status, 'attention');
  assert.equal(settingsRepository.hasConfirmedSyncThisSession, true);
  assert(Number.isFinite(Date.parse(settingsRepository.lastSyncAt)));

  const restoreRepository = repositoryState();
  restoreRepository.store = {
    saveSnapshot: async () => {},
    setMetadata: async () => {}
  };
  restoreRepository.reloadLocalState = async () => ({
    dirty: [],
    conflicts: [],
    acknowledgements: new Set(),
    revision: 1
  });
  restoreRepository.loadAdapter = async () => ({
    readItem: async () => ({
      document: updateRequired,
      exists: true
    })
  });

  await assert.rejects(
    restoreRepository.runFullRestore(emptyDocument('Jamie')),
    /Update required/
  );
  assert.equal(restoreRepository.hasConfirmedSyncThisSession, true);
  assert(Number.isFinite(Date.parse(restoreRepository.lastSyncAt)));
});

test('header freshness is dedicated, non-live, and rendered as text', async () => {
  const [html, appSource] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../js/app.js', import.meta.url), 'utf8')
  ]);
  const freshnessTag = html.match(/<span[^>]*id="shared-logbook-freshness"[^>]*>/)?.[0] || '';
  const syncButton = html.match(
    /<button[^>]*id="sync-status-btn"[^>]*>([\s\S]*?)<\/button>/
  )?.[1] || '';

  assert.match(freshnessTag, /class="header-freshness"/);
  assert.doesNotMatch(freshnessTag, /aria-live=|role=/);
  assert.doesNotMatch(syncButton, /shared-logbook-freshness/);
  assert.match(appSource, /freshness\.textContent = formatSharedLogbookAge\(normalized\);/);
  assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(appSource, /window\.addEventListener\('pageshow', updateFreshnessDisplay\);/);
});
