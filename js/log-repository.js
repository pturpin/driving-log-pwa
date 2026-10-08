import { LocalStateChangedError, LocalStore } from './local-store.js';
import { detectSessionConflicts } from './conflicts.js';
import { assertBackupCompatible } from './export.js';
import {
  CLIENT_VERSION,
  SCHEMA_VERSION,
  copyAllowedSession,
  createId,
  emptyDocument,
  entityEquals,
  isClientUpdateRequired,
  nextRevision,
  normalizePastTimestamp,
  normalizeRemoteDocument,
  normalizeSettings,
  serializeRemoteDocument,
  serializedByteLength,
  REMOTE_WARNING_BYTES,
  substantiveSessionEquals,
  validateEntityId
} from './utils.js';

function sessionKey(id) {
  return `session:${id}`;
}

function remoteSession(document, id) {
  return document.sessions.find((session) => session.id === id) || null;
}

function remoteTombstone(document, id) {
  return document.deletedSessions.find((session) => session.id === id) || null;
}

function cloneDocument(document) {
  return {
    driverId: document.driverId,
    version: document.version,
    schemaVersion: document.schemaVersion,
    minimumClientVersion: document.minimumClientVersion,
    migratedAt: document.migratedAt,
    active: document.active ? { ...document.active } : null,
    sessions: document.sessions.map((session) => ({ ...session })),
    deletedSessions: document.deletedSessions.map((session) => ({ ...session })),
    settings: { ...document.settings },
    passthrough: document.passthrough,
    quarantine: [...(document.quarantine || [])]
  };
}

function entityFor(document, dirty) {
  if (dirty.kind === 'active') return document.active;
  return remoteSession(document, dirty.entityId);
}

function stateMatchesLocal(document, dirty) {
  if (dirty.kind === 'active') return entityEquals(document.active, dirty.local);
  if (dirty.local) return entityEquals(remoteSession(document, dirty.entityId), dirty.local);
  return !remoteSession(document, dirty.entityId) && !!remoteTombstone(document, dirty.entityId);
}

function positivelyAuthored(document, dirty, deviceId) {
  if (dirty.kind === 'active') {
    return !!dirty.local && entityEquals(document.active, dirty.local) &&
      document.active.updatedBy === deviceId;
  }
  if (dirty.local) {
    const remote = remoteSession(document, dirty.entityId);
    return entityEquals(remote, dirty.local) && remote?.updatedBy === deviceId;
  }
  const tombstone = remoteTombstone(document, dirty.entityId);
  return !!tombstone && tombstone.deletedBy === deviceId &&
    tombstone.revision === dirty.tombstone?.revision &&
    tombstone.updatedBy === deviceId &&
    tombstone.deletedAt === dirty.tombstone?.deletedAt &&
    substantiveSessionEquals(tombstone, dirty.tombstone);
}

function tombstoneEquals(left, right) {
  return entityEquals(left, right) &&
    left?.createdAt === right?.createdAt &&
    left?.updatedAt === right?.updatedAt &&
    left?.deletedAt === right?.deletedAt &&
    left?.deletedBy === right?.deletedBy;
}

function attemptedStateMatches(document, dirty, deviceId) {
  const attempted = dirty.uncertainAttempt;
  if (!attempted) return false;
  if (dirty.kind === 'active') {
    return attempted.local === null
      ? document.active === null
      : entityEquals(document.active, attempted.local) &&
          document.active?.updatedBy === deviceId;
  }
  if (attempted.local) {
    const remote = remoteSession(document, dirty.entityId);
    return entityEquals(remote, attempted.local) && remote?.updatedBy === deviceId;
  }
  if (attempted.tombstone) {
    const tombstone = remoteTombstone(document, dirty.entityId);
    return tombstoneEquals(tombstone, attempted.tombstone) &&
      tombstone?.updatedBy === deviceId &&
      tombstone?.deletedBy === deviceId;
  }
  return false;
}

function canRebase(document, dirty, deviceId) {
  if (dirty.kind === 'active') {
    return entityEquals(document.active, dirty.base) ||
      attemptedStateMatches(document, dirty, deviceId);
  }
  const remote = remoteSession(document, dirty.entityId);
  const tombstone = remoteTombstone(document, dirty.entityId);
  if (dirty.baseTombstone) {
    if (remote === null && tombstoneEquals(tombstone, dirty.baseTombstone)) return true;
    return attemptedStateMatches(document, dirty, deviceId);
  }
  if (dirty.base === null) {
    if (remote === null && tombstone === null) return true;
    return attemptedStateMatches(document, dirty, deviceId);
  }
  if (tombstone === null && entityEquals(remote, dirty.base)) return true;
  return attemptedStateMatches(document, dirty, deviceId);
}

function applyDirty(document, dirty) {
  if (dirty.kind === 'active') {
    document.active = dirty.local ? { ...dirty.local } : null;
    return;
  }
  document.sessions = document.sessions.filter((session) => session.id !== dirty.entityId);
  document.deletedSessions = document.deletedSessions.filter((session) => session.id !== dirty.entityId);
  if (dirty.local) document.sessions.push({ ...dirty.local });
  else document.deletedSessions.push({ ...dirty.tombstone });
}

export function projectDocument(snapshot, dirtyRecords) {
  const projected = cloneDocument(snapshot);
  dirtyRecords.forEach((record) => applyDirty(projected, record));
  return projected;
}

export function classifyDirtyForSync(snapshot, dirtyRecords, deviceId) {
  const dirtyByGroup = new Map();
  for (const dirty of dirtyRecords) {
    const group = dirty.groupId || `single:${dirty.entityKey}`;
    if (!dirtyByGroup.has(group)) dirtyByGroup.set(group, []);
    dirtyByGroup.get(group).push(dirty);
  }
  const appliedKeys = [];
  const appliedRecords = [];
  const eligible = [];
  const blocked = [];
  for (const [groupId, records] of dirtyByGroup) {
    const allStateMatches = records.every((record) => stateMatchesLocal(snapshot, record));
    const hasPositiveAuthorship = records.some((record) =>
      positivelyAuthored(snapshot, record, deviceId)
    );
    if (allStateMatches && hasPositiveAuthorship) {
      records.forEach((record) => {
        appliedKeys.push(record.entityKey);
        appliedRecords.push(record);
      });
    } else if (records.every((record) => canRebase(snapshot, record, deviceId))) {
      eligible.push(...records);
    } else {
      blocked.push({ groupId, records });
    }
  }
  return { appliedKeys, appliedRecords, eligible, blocked };
}

export class LogRepository {
  constructor(config) {
    this.config = config;
    this.store = new LocalStore(config.driver);
    this.snapshot = emptyDocument(config.driver);
    this.dirty = [];
    this.technicalConflicts = [];
    this.derivedConflicts = [];
    this.acknowledgements = new Set();
    this.listeners = new Set();
    this.syncPromise = null;
    this.status = 'offline';
    this.lastError = '';
    this.freshnessWarning = '';
    this.lastSyncAt = null;
    this.hasConfirmedSyncThisSession = false;
    this.deviceId = null;
    this.storagePersisted = null;
    this.externalReloadPromise = null;
    this.unsubscribeStoreChanges = null;
  }

  async init() {
    this.deviceId = await this.store.getMetadata('installationId');
    if (!this.deviceId) {
      this.deviceId = createId();
      await this.store.setMetadata('installationId', this.deviceId);
    }
    this.lastSyncAt = normalizePastTimestamp(await this.store.getMetadata('lastSyncAt'));
    await this.reloadLocalState({ notify: false });
    this.unsubscribeStoreChanges = this.store.subscribeChanges(() => {
      const reload = (this.externalReloadPromise || Promise.resolve())
        .then(() => this.reloadLocalState())
        .catch((error) => {
          this.lastError = error.message || 'Local changes could not be reloaded.';
          this.recompute();
          this.notify();
        });
      this.externalReloadPromise = reload;
      reload.finally(() => {
        if (this.externalReloadPromise === reload) this.externalReloadPromise = null;
      });
    });
    this.storagePersisted = await navigator.storage?.persisted?.().catch(() => null) ?? null;
    this.recompute();
    return this.getState();
  }

  async reloadLocalState({ notify = true } = {}) {
    const [snapshot, operational] = await Promise.all([
      this.store.latestSnapshot(),
      this.store.operationalState()
    ]);
    this.snapshot = snapshot || emptyDocument(this.config.driver);
    this.dirty = operational.dirty;
    this.technicalConflicts = operational.conflicts;
    this.acknowledgements = operational.acknowledgements;
    this.recompute();
    if (notify) this.notify();
    return operational;
  }

  async reconcileLocalState(error) {
    if (!(error instanceof LocalStateChangedError)) throw error;
    await this.reloadLocalState({ notify: false });
    this.lastError = error.message;
    this.status = this.dirty.length || this.technicalConflicts.length ? 'attention' : this.status;
    this.recompute();
    this.notify();
    throw error;
  }

  async persistDirty(records, deleteRecords = []) {
    try {
      return await this.store.putDirtyMany(records, deleteRecords);
    } catch (error) {
      return this.reconcileLocalState(error);
    }
  }

  async persistOneDirty(record) {
    return (await this.persistDirty([record]))[0];
  }

  async removeDirty(records) {
    await this.persistDirty([], records);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.getState();
    this.listeners.forEach((listener) => listener(state));
  }

  effectiveDocument() {
    return projectDocument(this.snapshot, this.dirty);
  }

  recompute() {
    const effective = this.effectiveDocument();
    this.derivedConflicts = detectSessionConflicts(effective.sessions, {
      migratedAt: effective.migratedAt,
      acknowledgements: this.acknowledgements
    });
    const unacknowledged = this.derivedConflicts.filter((conflict) => !conflict.acknowledged);
    if (this.status !== 'syncing') {
      if (isClientUpdateRequired(effective, CLIENT_VERSION)) this.status = 'attention';
      else if (this.technicalConflicts.length || unacknowledged.length) this.status = 'attention';
      else if (this.lastError) {
        if (!['offline', 'pending', 'attention'].includes(this.status)) {
          this.status = this.dirty.length ? 'pending' : 'offline';
        }
      }
      else if (this.dirty.length) this.status = navigator.onLine ? 'pending' : 'offline';
      else if (!navigator.onLine) this.status = 'offline';
      else if (this.hasConfirmedSyncThisSession) this.status = 'synced';
    }
  }

  getState() {
    const item = this.effectiveDocument();
    const derived = this.derivedConflicts.filter((conflict) => !conflict.acknowledged);
    return {
      item,
      dirtyCount: this.dirty.length,
      conflicts: [...this.technicalConflicts, ...derived],
      allDerivedConflicts: this.derivedConflicts,
      status: this.status,
      lastError: this.lastError,
      freshnessWarning: this.freshnessWarning,
      lastSyncAt: this.lastSyncAt,
      updateRequired: isClientUpdateRequired(item, CLIENT_VERSION),
      remoteBytes: serializedByteLength(item),
      sizeWarning: serializedByteLength(item) >= REMOTE_WARNING_BYTES,
      deviceId: this.deviceId,
      storagePersisted: this.storagePersisted
    };
  }

  assertWritable() {
    if (isClientUpdateRequired(this.snapshot, CLIENT_VERSION)) {
      throw new Error('Update required before making more changes. Your pending data remains on this device.');
    }
  }

  async makeSessionDirty(input, { groupId = null } = {}) {
    this.assertWritable();
    const id = validateEntityId(input.id, 'session ID');
    const entityKey = sessionKey(id);
    const existingDirty = this.dirty.find((entry) => entry.entityKey === entityKey);
    const base = existingDirty ? existingDirty.base : remoteSession(this.snapshot, id);
    const previousLocal = existingDirty?.local || base;
    const now = new Date().toISOString();
    const local = {
      ...copyAllowedSession({
        ...input,
        id,
        timeKind: input.timeKind || 'explicit',
        source: input.source || previousLocal?.source || 'manual',
        createdAt: previousLocal?.createdAt || now,
        updatedAt: now,
        revision: existingDirty?.local?.revision || (base?.revision || 0) + 1,
        updatedBy: this.deviceId
      })
    };
    return {
      key: existingDirty?.key,
      writeId: existingDirty?.writeId || null,
      entityKey,
      entityId: id,
      kind: 'session',
      base: base ? { ...base } : null,
      baseTombstone: existingDirty?.baseTombstone
        ? { ...existingDirty.baseTombstone }
        : null,
      local,
      tombstone: null,
      uncertainAttempt: existingDirty?.uncertainAttempt || null,
      groupId: groupId || existingDirty?.groupId || null,
      sequence: existingDirty?.sequence || await this.store.nextSequence(),
      changedAt: now
    };
  }

  async saveSession(input) {
    const record = await this.makeSessionDirty(input);
    const persisted = await this.persistOneDirty(record);
    this.replaceDirty(persisted);
    this.afterLocalChange();
    return persisted.local;
  }

  async makeDeleteDirty(id, { groupId = null } = {}) {
    this.assertWritable();
    const entityKey = sessionKey(validateEntityId(id, 'session ID'));
    const existingDirty = this.dirty.find((entry) => entry.entityKey === entityKey);
    if (existingDirty?.base === null && !existingDirty.uncertainAttempt) {
      const cancelRecords = existingDirty.groupId
        ? this.dirty.filter((entry) => entry.groupId === existingDirty.groupId)
        : [existingDirty];
      return { cancelCreate: true, entityKey, cancelRecords };
    }
    const base = existingDirty ? existingDirty.base : remoteSession(this.snapshot, id);
    const source = existingDirty?.local || base;
    if (!source) return { noOp: true, entityKey };
    const now = new Date().toISOString();
    const revision = existingDirty?.uncertainAttempt
      ? (existingDirty.local?.revision || base?.revision || 0) + 1
      : existingDirty?.local?.revision || (base.revision || 0) + 1;
    return {
      key: existingDirty?.key,
      writeId: existingDirty?.writeId || null,
      entityKey,
      entityId: id,
      kind: 'session',
      base: base ? { ...base } : null,
      baseTombstone: existingDirty?.baseTombstone
        ? { ...existingDirty.baseTombstone }
        : null,
      local: null,
      tombstone: {
        ...copyAllowedSession({
          ...source,
          updatedAt: now,
          revision,
          updatedBy: this.deviceId
        }),
        deletedAt: now,
        deletedBy: this.deviceId
      },
      uncertainAttempt: existingDirty?.uncertainAttempt || null,
      groupId: groupId || existingDirty?.groupId || null,
      sequence: existingDirty?.sequence || await this.store.nextSequence(),
      changedAt: now
    };
  }

  async deleteSession(id) {
    const record = await this.makeDeleteDirty(id);
    if (record.cancelCreate) {
      await this.removeDirty(record.cancelRecords);
      const cancelled = new Map(record.cancelRecords.map((entry) => [entry.entityKey, entry.writeId]));
      this.dirty = this.dirty.filter((entry) =>
        cancelled.get(entry.entityKey) !== entry.writeId
      );
    } else if (!record.noOp) {
      const existing = this.dirty.find((entry) => entry.entityKey === record.entityKey);
      const replacements = existing?.base === null &&
        existing.uncertainAttempt &&
        existing.groupId
        ? this.reverseUncertainAtomicCreate(existing, record)
        : [record];
      const persisted = await this.persistDirty(replacements);
      persisted.forEach((entry) => this.replaceDirty(entry));
    }
    this.afterLocalChange();
  }

  reverseUncertainAtomicCreate(createRecord, deleteRecord) {
    const now = deleteRecord.changedAt;
    return this.dirty
      .filter((entry) => entry.groupId === createRecord.groupId)
      .map((entry) => {
        if (entry.entityKey === createRecord.entityKey) return deleteRecord;
        if (entry.kind !== 'session' || entry.local || !entry.base) {
          throw new Error('The uncertain atomic change cannot be reversed safely yet.');
        }
        const attemptedTombstone = entry.uncertainAttempt?.tombstone || entry.tombstone;
        return {
          ...entry,
          local: copyAllowedSession({
            ...(attemptedTombstone || entry.base),
            ...nextRevision(attemptedTombstone, this.deviceId, now)
          }),
          tombstone: null,
          changedAt: now
        };
      });
  }

  async startActive(startedAt = new Date().toISOString()) {
    this.assertWritable();
    if (this.effectiveDocument().active) throw new Error('A drive is already in progress.');
    const existing = this.dirty.find((entry) => entry.entityKey === 'active');
    const base = existing ? existing.base : this.snapshot.active;
    const local = {
      id: existing?.local?.id || createId(),
      startedAt,
      revision: existing?.local?.revision || (base?.revision || 0) + 1,
      updatedBy: this.deviceId
    };
    const record = {
      writeId: existing?.writeId || null,
      entityKey: 'active',
      entityId: 'active',
      kind: 'active',
      base: base ? { ...base } : null,
      local,
      groupId: existing?.groupId || null,
      sequence: existing?.sequence || await this.store.nextSequence(),
      changedAt: new Date().toISOString()
    };
    const persisted = await this.persistOneDirty(record);
    this.replaceDirty(persisted);
    this.afterLocalChange();
    return persisted.local;
  }

  async stopActive(sessionInput) {
    this.assertWritable();
    const currentActive = this.effectiveDocument().active;
    if (!currentActive) throw new Error('No drive is currently in progress.');
    const groupId = createId();
    const sessionRecord = await this.makeSessionDirty(sessionInput, { groupId });
    const existingActive = this.dirty.find((entry) => entry.entityKey === 'active');
    const activeRecord = {
      writeId: existingActive?.writeId || null,
      entityKey: 'active',
      entityId: 'active',
      kind: 'active',
      base: existingActive ? existingActive.base : this.snapshot.active,
      local: null,
      groupId,
      sequence: existingActive?.sequence || await this.store.nextSequence(),
      changedAt: new Date().toISOString()
    };
    const persisted = await this.persistDirty([sessionRecord, activeRecord]);
    persisted.forEach((record) => this.replaceDirty(record));
    this.afterLocalChange();
    return persisted.find((record) => record.entityKey === sessionRecord.entityKey).local;
  }

  async mergeSessions(mergedInput, sourceIds) {
    this.assertWritable();
    const ids = [...new Set(sourceIds.map((id) => validateEntityId(id, 'session ID')))];
    if (ids.length < 2) throw new Error('Select at least two entries to merge.');
    const groupId = createId();
    const createRecord = await this.makeSessionDirty(mergedInput, { groupId });
    const deleteRecords = [];
    for (const id of ids) {
      const record = await this.makeDeleteDirty(id, { groupId });
      if (record.cancelCreate || record.noOp) throw new Error('A source entry is no longer available to merge.');
      deleteRecords.push(record);
    }
    const records = [createRecord, ...deleteRecords];
    const persisted = await this.persistDirty(records);
    persisted.forEach((record) => this.replaceDirty(record));
    this.afterLocalChange();
    return persisted.find((record) => record.entityKey === createRecord.entityKey).local;
  }

  replaceDirty(record) {
    this.dirty = this.dirty.filter((entry) => entry.entityKey !== record.entityKey);
    this.dirty.push(record);
    this.dirty.sort((a, b) => a.sequence - b.sequence);
  }

  afterLocalChange() {
    this.lastError = '';
    this.status = navigator.onLine ? 'pending' : 'offline';
    this.recompute();
    this.notify();
  }

  async loadAdapter() {
    return import('./dynamo.js');
  }

  async sync(reason = 'manual') {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSync(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async runSync() {
    this.status = 'syncing';
    this.lastError = '';
    this.notify();
    const adapter = await this.loadAdapter();
    for (let attempt = 0; attempt < 4; attempt++) {
      let read;
      try {
        read = await adapter.readItem(this.config, this.snapshot);
      } catch (error) {
        this.status = this.dirty.length ? 'pending' : 'offline';
        this.lastError = error.message || 'Sync failed.';
        this.recompute();
        this.notify();
        throw error;
      }
      await this.recordSuccessfulCheck();
      this.snapshot = read.document;
      await this.store.saveSnapshot(this.snapshot);
      this.recordValidationIssues(read.issues);
      if (isClientUpdateRequired(this.snapshot, CLIENT_VERSION)) {
        this.status = 'attention';
        this.lastError = 'Update required before pending changes can sync. Local changes were retained.';
        await this.persistConflicts();
        this.recompute();
        this.notify();
        return this.getState();
      }
      if (read.repairBlocked) {
        this.status = 'attention';
        this.lastError = 'Remote data needs review before pending changes can sync. The remote item was left unchanged.';
        await this.persistConflicts();
        this.recompute();
        this.notify();
        return this.getState();
      }
      const classification = classifyDirtyForSync(this.snapshot, this.dirty, this.deviceId);
      const { appliedKeys, appliedRecords, eligible } = classification;
      const conflicts = classification.blocked.map(({ groupId, records }) =>
        this.makeTechnicalConflict(groupId, records, this.snapshot)
      );
      if (appliedKeys.length) {
        try {
          await this.removeDirty(appliedRecords);
        } catch (error) {
          if (error instanceof LocalStateChangedError) continue;
          throw error;
        }
        const appliedTokens = new Map(appliedRecords.map((record) => [record.entityKey, record.writeId]));
        this.dirty = this.dirty.filter((record) =>
          appliedTokens.get(record.entityKey) !== record.writeId
        );
      }
      this.replaceTechnicalSyncConflicts(conflicts);
      if (!eligible.length) {
        await this.persistConflicts();
        await this.requestPersistentStorage();
        this.status = this.dirty.length ? 'attention' : 'synced';
        this.recompute();
        this.notify();
        return this.getState();
      }
      const next = cloneDocument(this.snapshot);
      eligible.forEach((record) => applyDirty(next, record));
      next.schemaVersion = SCHEMA_VERSION;
      next.minimumClientVersion = CLIENT_VERSION;
      const attemptedAt = new Date().toISOString();
      let attemptedRecords;
      try {
        attemptedRecords = await this.persistDirty(eligible.map((record) => ({
          ...record,
          uncertainAttempt: {
            attemptedAt,
            local: record.local ? { ...record.local } : null,
            tombstone: record.tombstone ? { ...record.tombstone } : null
          }
        })));
      } catch (error) {
        if (error instanceof LocalStateChangedError) continue;
        throw error;
      }
      attemptedRecords.forEach((record) => this.replaceDirty(record));
      try {
        const written = await adapter.writeItem(
          this.config,
          next,
          this.snapshot.version,
          read.exists
        );
        this.snapshot = written;
        const committedRecords = [];
        const rebasedDuringWrite = [];
        const now = new Date().toISOString();
        for (const record of attemptedRecords) {
          const current = this.dirty.find((entry) => entry.entityKey === record.entityKey);
          if (current?.writeId === record.writeId) {
            committedRecords.push(record);
            continue;
          }
          if (!current) continue;
          const base = entityFor(written, current);
          const baseTombstone = current.kind === 'session' && !base
            ? remoteTombstone(written, current.entityId)
            : null;
          const rebased = {
            ...current,
            base: base ? { ...base } : null,
            baseTombstone: current.kind === 'session' && current.local && baseTombstone
              ? { ...baseTombstone }
              : null,
            uncertainAttempt: null,
            groupId: current.groupId || null,
            changedAt: now
          };
          if (rebased.local) {
            rebased.local = rebased.kind === 'active'
              ? {
                  ...rebased.local,
                  revision: (base?.revision || 0) + 1,
                  updatedBy: this.deviceId
                }
              : {
                  ...rebased.local,
                  ...nextRevision(base || baseTombstone, this.deviceId, now)
                };
          } else if (rebased.tombstone) {
            rebased.tombstone = {
              ...rebased.tombstone,
              ...nextRevision(base, this.deviceId, now),
              deletedAt: now,
              deletedBy: this.deviceId
            };
          }
          rebasedDuringWrite.push(rebased);
        }
        await this.store.saveSnapshot(written);
        let persistedRebased;
        try {
          persistedRebased = await this.persistDirty(rebasedDuringWrite, committedRecords);
        } catch (error) {
          if (error instanceof LocalStateChangedError) continue;
          throw error;
        }
        const committedTokens = new Map(
          committedRecords.map((record) => [record.entityKey, record.writeId])
        );
        this.dirty = this.dirty.filter((record) =>
          committedTokens.get(record.entityKey) !== record.writeId
        );
        persistedRebased.forEach((record) => this.replaceDirty(record));
        await this.persistConflicts();
        await this.requestPersistentStorage();
        this.status = this.dirty.length ? 'attention' : 'synced';
        this.recompute();
        this.notify();
        return this.getState();
      } catch (error) {
        if (error instanceof adapter.ConditionalWriteError) continue;
        this.status = 'pending';
        this.lastError = error.message || 'The write outcome is uncertain; local changes were retained.';
        this.recompute();
        this.notify();
        throw error;
      }
    }
    this.status = 'pending';
    this.lastError = 'The shared log kept changing. Local changes were retained; try Sync again.';
    this.recompute();
    this.notify();
    throw new Error(this.lastError);
  }

  recordValidationIssues(issues) {
    const retained = this.technicalConflicts.filter((conflict) =>
      conflict.type !== 'data' || conflict.sticky
    );
    const visibleIssues = issues.filter((issue) =>
      issue.code.startsWith('quarantined') ||
      issue.code === 'legacy-session-change' ||
      issue.code === 'legacy-active' ||
      issue.code === 'invalid-sessions' ||
      issue.code === 'invalid-deletions' ||
      issue.code === 'invalid-settings' ||
      issue.code === 'invalid-setting' ||
      issue.code === 'invalid-passthrough' ||
      issue.code === 'oversized-passthrough' ||
      issue.code === 'invalid-schema-version' ||
      issue.code === 'invalid-client-version' ||
      issue.code === 'invalid-migration-date' ||
      issue.code === 'invalid-version'
    );
    const dataIssues = visibleIssues.map((issue, index) => ({
      id: `data_${issue.code}_${issue.entityId || index}`,
      type: 'data',
      code: issue.code,
      sticky: issue.code === 'legacy-active',
      title: 'Remote data needs review',
      message: issue.message,
      entityId: issue.entityId || null,
      createdAt: new Date().toISOString()
    }));
    const ids = new Set(retained.map((conflict) => conflict.id));
    this.technicalConflicts = [...retained, ...dataIssues.filter((conflict) => !ids.has(conflict.id))];
  }

  replaceTechnicalSyncConflicts(conflicts) {
    const data = this.technicalConflicts.filter((conflict) => conflict.type === 'data');
    this.technicalConflicts = [...data, ...conflicts];
  }

  makeTechnicalConflict(groupId, records, remote) {
    const isActive = records.length === 1 && records[0].kind === 'active';
    return {
      id: `technical_${groupId.replace(/[^A-Za-z0-9_-]/g, '_')}`,
      type: isActive ? 'active' : 'technical',
      title: isActive ? 'Active drive changed elsewhere' : 'Entry changed elsewhere',
      message: records.length > 1
        ? 'An atomic group could not be applied without overwriting another device.'
        : 'Local and remote changes need a decision.',
      entityId: records.length === 1 ? records[0].entityId : null,
      entityKeys: records.map((record) => record.entityKey),
      groupId,
      candidates: records.map((record) => ({
        entityKey: record.entityKey,
        entityId: record.entityId,
        kind: record.kind,
        base: record.base,
        local: record.local,
        remote: entityFor(remote, record)
      })),
      createdAt: new Date().toISOString()
    };
  }

  async persistConflicts() {
    await this.store.putConflicts(this.technicalConflicts);
  }

  async recordSuccessfulCheck() {
    this.lastSyncAt = new Date().toISOString();
    this.hasConfirmedSyncThisSession = true;
    try {
      await this.store.setMetadata('lastSyncAt', this.lastSyncAt);
      this.freshnessWarning = '';
    } catch {
      this.freshnessWarning = 'Shared logbook was checked, but this device could not save the check time for the next app restart.';
    }
  }

  async requestPersistentStorage() {
    if (!navigator.storage?.persist || this.storagePersisted === true) return;
    try {
      this.storagePersisted = await navigator.storage.persist();
    } catch {
      this.storagePersisted = false;
    }
  }

  async snapshotHistory() {
    return this.store.snapshotHistory();
  }

  async updateSettings(settings) {
    if (this.syncPromise) {
      try {
        await this.syncPromise;
      } catch {
        // A failed sync retains local work; the clean-state check below decides.
      }
    }
    this.status = 'syncing';
    this.lastError = '';
    this.notify();
    this.syncPromise = this.runSettingsUpdate(settings)
      .catch((error) => {
        this.status = this.dirty.length ? 'pending' : 'offline';
        this.lastError = error.message || 'Settings were not saved.';
        this.recompute();
        this.notify();
        throw error;
      })
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  async runSettingsUpdate(settings) {
    this.assertWritable();
    if (this.dirty.length) throw new Error('Sync or resolve pending log changes before changing settings.');
    const adapter = await this.loadAdapter();
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = await adapter.readItem(this.config, this.snapshot);
      await this.recordSuccessfulCheck();
      this.snapshot = read.document;
      await this.store.saveSnapshot(this.snapshot);
      this.recordValidationIssues(read.issues);
      if (isClientUpdateRequired(this.snapshot, CLIENT_VERSION)) {
        this.recompute();
        this.notify();
        throw new Error('Update required before changing settings.');
      }
      if (read.repairBlocked) {
        this.status = 'attention';
        this.lastError = 'Remote data needs review before settings can change. The remote item was left unchanged.';
        await this.persistConflicts();
        this.recompute();
        this.notify();
        throw new Error(this.lastError);
      }
      const next = cloneDocument(this.snapshot);
      next.settings = normalizeSettings(settings);
      try {
        const written = await adapter.writeItem(this.config, next, this.snapshot.version, read.exists);
        this.snapshot = written;
        await this.store.saveSnapshot(written);
        this.status = 'synced';
        this.recompute();
        this.notify();
        return written.settings;
      } catch (error) {
        if (error instanceof adapter.ConditionalWriteError) continue;
        throw error;
      }
    }
    throw new Error('Settings changed elsewhere repeatedly. Try again.');
  }

  async importBackup(document) {
    assertBackupCompatible(document);
    this.assertWritable();
    const normalized = normalizeRemoteDocument(document, {
      driverId: this.config.driver,
      previous: this.effectiveDocument()
    }).document;
    assertBackupCompatible(normalized);
    const records = [];
    const effective = this.effectiveDocument();
    for (const session of normalized.sessions) {
      const current = effective.sessions.find((entry) => entry.id === session.id);
      if (!current || !substantiveSessionEquals(current, session)) {
        records.push(await this.makeSessionDirty({
          ...session,
          source: session.source || 'imported'
        }));
      }
    }
    for (const tombstone of normalized.deletedSessions) {
      if (effective.sessions.some((session) => session.id === tombstone.id)) {
        const deletion = await this.makeDeleteDirty(tombstone.id);
        if (!deletion.noOp && !deletion.cancelCreate) records.push(deletion);
      }
    }
    if (records.length) {
      const persisted = await this.persistDirty(records);
      persisted.forEach((record) => this.replaceDirty(record));
      this.afterLocalChange();
    }
    return records.length;
  }

  async fullRestore(document) {
    assertBackupCompatible(document);
    if (this.syncPromise) {
      try {
        await this.syncPromise;
      } catch {
        // Continue to the strict restore preconditions below.
      }
    }
    this.status = 'syncing';
    this.lastError = '';
    this.notify();
    this.syncPromise = this.runFullRestore(document)
      .catch((error) => {
        this.status = this.dirty.length || this.technicalConflicts.length
          ? 'attention'
          : 'offline';
        this.lastError = error.message || 'Full restore was not confirmed.';
        this.recompute();
        this.notify();
        throw error;
      })
      .finally(() => {
        this.syncPromise = null;
      });
    return this.syncPromise;
  }

  async runFullRestore(document) {
    assertBackupCompatible(document);
    const operational = await this.reloadLocalState({ notify: false });
    this.assertWritable();
    if (operational.dirty.length) {
      throw new Error('Full restore requires zero pending local changes in every open tab.');
    }
    if (!navigator.onLine) throw new Error('Full restore requires a confirmed network connection.');
    const adapter = await this.loadAdapter();
    const read = await adapter.readItem(this.config, this.snapshot);
    await this.recordSuccessfulCheck();
    if (isClientUpdateRequired(read.document, CLIENT_VERSION)) {
      this.snapshot = read.document;
      await this.store.saveSnapshot(read.document);
      this.recompute();
      this.notify();
      throw new Error('Update required before restoring this logbook.');
    }
    const candidate = normalizeRemoteDocument(document, { driverId: this.config.driver }).document;
    const raw = serializeRemoteDocument(candidate);
    raw.driverId = this.config.driver;
    raw.version = read.document.version;
    raw.schemaVersion = SCHEMA_VERSION;
    raw.minimumClientVersion = CLIENT_VERSION;
    const normalized = normalizeRemoteDocument(raw, { driverId: this.config.driver }).document;
    const written = await adapter.writeItem(this.config, normalized, read.document.version, read.exists);
    try {
      await this.store.clearOperationalStateAndSave(written, operational.revision);
    } catch (error) {
      if (error instanceof LocalStateChangedError) {
        await this.store.saveSnapshot(written);
        await this.reloadLocalState({ notify: false });
      }
      throw error;
    }
    this.snapshot = written;
    this.dirty = [];
    this.technicalConflicts = [];
    this.acknowledgements = new Set();
    this.status = 'synced';
    this.recompute();
    this.notify();
  }

  async acknowledgeDerivedConflict(id) {
    await this.store.acknowledge(id);
    this.acknowledgements.add(id);
    this.recompute();
    this.notify();
  }

  async resolveTechnicalConflict(id, action) {
    const conflict = this.technicalConflicts.find((entry) => entry.id === id);
    if (!conflict || conflict.type === 'data') return;
    const records = conflict.entityKeys
      .map((key) => this.dirty.find((record) => record.entityKey === key))
      .filter(Boolean);
    if (action === 'remote' || action === 'discard') {
      await this.removeDirty(records);
      const removed = new Map(records.map((record) => [record.entityKey, record.writeId]));
      this.dirty = this.dirty.filter((record) =>
        removed.get(record.entityKey) !== record.writeId
      );
    } else if (action === 'local') {
      const replacements = [];
      const removals = [];
      const now = new Date().toISOString();
      for (const record of records) {
        const base = entityFor(this.snapshot, record);
        const tombstone = record.kind === 'session'
          ? remoteTombstone(this.snapshot, record.entityId)
          : null;
        if (record.kind === 'session' && !record.local && tombstone) {
          removals.push(record);
          continue;
        }
        const replacement = {
          ...record,
          base: base ? { ...base } : null,
          baseTombstone: record.kind === 'session' && record.local && !base && tombstone
            ? { ...tombstone }
            : null,
          changedAt: now
        };
        if (replacement.local) {
          replacement.local = replacement.kind === 'active'
            ? {
                ...replacement.local,
                revision: (base?.revision || 0) + 1,
                updatedBy: this.deviceId
              }
            : {
                ...replacement.local,
                ...nextRevision(base || tombstone, this.deviceId, now)
              };
        } else if (replacement.tombstone) {
          replacement.tombstone = {
            ...replacement.tombstone,
            ...nextRevision(base, this.deviceId, now),
            deletedAt: now,
            deletedBy: this.deviceId
          };
        }
        replacements.push(replacement);
      }
      const persisted = await this.persistDirty(replacements, removals);
      const removed = new Map(removals.map((record) => [record.entityKey, record.writeId]));
      this.dirty = this.dirty.filter((record) =>
        removed.get(record.entityKey) !== record.writeId
      );
      persisted.forEach((record) => this.replaceDirty(record));
    } else if (action === 'both') {
      const replacements = [];
      const deleteRecords = [];
      const groupId = createId();
      const now = new Date().toISOString();
      for (const record of records) {
        if (record.kind === 'session' && record.local) {
          deleteRecords.push(record);
          replacements.push(await this.makeSessionDirty(
            { ...record.local, id: createId() },
            { groupId: null }
          ));
        } else if (record.kind === 'session') {
          const remote = remoteSession(this.snapshot, record.entityId);
          if (!remote) continue;
          replacements.push(await this.makeSessionDirty(
            { ...remote, id: createId() },
            { groupId }
          ));
          replacements.push({
            ...record,
            base: { ...remote },
            groupId,
            changedAt: now,
            tombstone: {
              ...copyAllowedSession({
                ...remote,
                ...nextRevision(remote, this.deviceId, now)
              }),
              deletedAt: now,
              deletedBy: this.deviceId
            }
          });
        }
      }
      const persisted = await this.persistDirty(replacements, deleteRecords);
      const removed = new Map(deleteRecords.map((record) => [record.entityKey, record.writeId]));
      this.dirty = this.dirty.filter((record) =>
        removed.get(record.entityKey) !== record.writeId
      );
      persisted.forEach((record) => this.replaceDirty(record));
    }
    this.technicalConflicts = this.technicalConflicts.filter((entry) => entry.id !== id);
    await this.persistConflicts();
    this.status = this.dirty.length ? 'pending' : 'synced';
    this.recompute();
    this.notify();
  }

  async resolveDataConflict(id, action = 'accept') {
    const conflict = this.technicalConflicts.find((entry) => entry.id === id && entry.type === 'data');
    if (!conflict) return;
    if (conflict.code === 'legacy-active' && action === 'clear' && this.snapshot.active) {
      const existing = this.dirty.find((entry) => entry.entityKey === 'active');
      const record = {
        writeId: existing?.writeId || null,
        entityKey: 'active',
        entityId: 'active',
        kind: 'active',
        base: existing ? existing.base : { ...this.snapshot.active },
        local: null,
        groupId: null,
        sequence: existing?.sequence || await this.store.nextSequence(),
        changedAt: new Date().toISOString()
      };
      const persisted = await this.persistOneDirty(record);
      this.replaceDirty(persisted);
    }
    this.technicalConflicts = this.technicalConflicts.filter((entry) => entry.id !== id);
    await this.persistConflicts();
    this.status = this.dirty.length ? 'pending' : 'synced';
    this.recompute();
    this.notify();
  }

  async resolveTechnicalWithMerged(id, input) {
    const conflict = this.technicalConflicts.find((entry) => entry.id === id);
    const candidate = conflict?.candidates?.find((entry) => entry.kind === 'session');
    const existing = candidate
      ? this.dirty.find((record) => record.entityKey === candidate.entityKey)
      : null;
    if (!conflict || !candidate || !existing) throw new Error('That conflict is no longer available.');
    const base = remoteSession(this.snapshot, candidate.entityId);
    const baseTombstone = base ? null : remoteTombstone(this.snapshot, candidate.entityId);
    const now = new Date().toISOString();
    const local = copyAllowedSession({
      ...input,
      id: candidate.entityId,
      source: 'merged',
      timeKind: 'explicit',
      createdAt: base?.createdAt || existing.local?.createdAt || now,
      updatedAt: now,
      revision: ((base || baseTombstone)?.revision || 0) + 1,
      updatedBy: this.deviceId
    });
    const replacement = {
      ...existing,
      base: base ? { ...base } : null,
      baseTombstone: baseTombstone ? { ...baseTombstone } : null,
      local,
      tombstone: null,
      groupId: null,
      changedAt: now
    };
    const persisted = await this.persistOneDirty(replacement);
    this.replaceDirty(persisted);
    this.technicalConflicts = this.technicalConflicts.filter((entry) => entry.id !== id);
    await this.persistConflicts();
    this.status = 'pending';
    this.recompute();
    this.notify();
    return persisted.local;
  }
}
