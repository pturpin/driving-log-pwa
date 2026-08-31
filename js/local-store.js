const DB_NAME = 'drivelog.offline.v2';
const DB_VERSION = 2;

export class LocalStateChangedError extends Error {
  constructor(message = 'Local state changed in another tab. Reload and try again.') {
    super(message);
    this.name = 'LocalStateChangedError';
  }
}

function createWriteId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
  });
}

async function openDatabase() {
  if (!globalThis.indexedDB) throw new Error('This browser does not provide IndexedDB.');
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    for (const name of ['remoteSnapshot', 'dirtyEntities', 'conflicts', 'acknowledgements', 'metadata']) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
    }
    if (event.oldVersion > 0 && event.oldVersion < 2) {
      const dirtyStore = request.transaction.objectStore('dirtyEntities');
      dirtyStore.openCursor().onsuccess = (cursorEvent) => {
        const cursor = cursorEvent.target.result;
        if (!cursor) return;
        if (!cursor.value.writeId) cursor.update({ ...cursor.value, writeId: createWriteId() });
        cursor.continue();
      };
    }
  };
  return requestResult(request);
}

export class LocalStore {
  constructor(driverId) {
    this.driverId = driverId;
    this.dbPromise = openDatabase();
    this.changeSource = createWriteId();
    this.changeListeners = new Set();
    this.changeChannel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(`${DB_NAME}.changes`)
      : null;
    this.changeChannel?.addEventListener('message', (event) => {
      if (event.data?.driverId !== this.driverId || event.data?.source === this.changeSource) return;
      this.changeListeners.forEach((listener) => listener(event.data));
    });
  }

  scopedKey(suffix) {
    return `${this.driverId}|${suffix}`;
  }

  subscribeChanges(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  broadcastChange(kind) {
    this.changeChannel?.postMessage({
      driverId: this.driverId,
      source: this.changeSource,
      kind
    });
  }

  async bumpOperationalRevision(store) {
    const key = this.scopedKey('operationalRevision');
    const existing = await requestResult(store.get(key));
    const value = Math.max(0, Number(existing?.value) || 0) + 1;
    store.put({ key, scope: this.driverId, name: 'operationalRevision', value });
    return value;
  }

  async getMetadata(name, fallback = null) {
    const db = await this.dbPromise;
    const tx = db.transaction('metadata', 'readonly');
    const record = await requestResult(tx.objectStore('metadata').get(this.scopedKey(name)));
    await transactionDone(tx);
    return record ? record.value : fallback;
  }

  async setMetadata(name, value) {
    const db = await this.dbPromise;
    const tx = db.transaction('metadata', 'readwrite');
    tx.objectStore('metadata').put({ key: this.scopedKey(name), scope: this.driverId, name, value });
    await transactionDone(tx);
  }

  async nextSequence() {
    const db = await this.dbPromise;
    const tx = db.transaction('metadata', 'readwrite');
    const store = tx.objectStore('metadata');
    const key = this.scopedKey('deviceSequence');
    const existing = await requestResult(store.get(key));
    const value = Math.max(0, Number(existing?.value) || 0) + 1;
    store.put({ key, scope: this.driverId, name: 'deviceSequence', value });
    await transactionDone(tx);
    return value;
  }

  async listStore(name) {
    const db = await this.dbPromise;
    const tx = db.transaction(name, 'readonly');
    const records = await requestResult(tx.objectStore(name).getAll());
    await transactionDone(tx);
    return records.filter((record) => record.scope === this.driverId);
  }

  async latestSnapshot() {
    const snapshots = await this.listStore('remoteSnapshot');
    snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return snapshots[0]?.document || null;
  }

  async snapshotHistory() {
    const snapshots = await this.listStore('remoteSnapshot');
    return snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map((entry) => entry.document);
  }

  async saveSnapshot(document) {
    const db = await this.dbPromise;
    const tx = db.transaction(['remoteSnapshot', 'metadata'], 'readwrite');
    const store = tx.objectStore('remoteSnapshot');
    const savedAt = new Date().toISOString();
    const key = this.scopedKey(`${String(document.version).padStart(12, '0')}|${savedAt}`);
    const all = await requestResult(store.getAll());
    const scoped = all.filter((entry) => entry.scope === this.driverId)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    if (scoped[0] && JSON.stringify(scoped[0].document) === JSON.stringify(document)) {
      await transactionDone(tx);
      return;
    }
    store.put({ key, scope: this.driverId, savedAt, version: document.version, document });
    scoped.slice(4).forEach((entry) => store.delete(entry.key));
    await this.bumpOperationalRevision(tx.objectStore('metadata'));
    await transactionDone(tx);
    this.broadcastChange('snapshot');
  }

  async listDirty() {
    const records = await this.listStore('dirtyEntities');
    return records.sort((a, b) => a.sequence - b.sequence);
  }

  async putDirty(record) {
    return (await this.putDirtyMany([record]))[0];
  }

  async putDirtyMany(records, deleteRecords = []) {
    const entityKeys = [...records, ...deleteRecords].map((record) => record.entityKey);
    if (new Set(entityKeys).size !== entityKeys.length) {
      throw new Error('A dirty-state transaction cannot update the same entry twice.');
    }
    const db = await this.dbPromise;
    const tx = db.transaction(['dirtyEntities', 'metadata'], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore('dirtyEntities');
    for (const record of [...records, ...deleteRecords]) {
      const current = await requestResult(store.get(this.scopedKey(record.entityKey)));
      const expectedWriteId = record.writeId || null;
      if ((current?.writeId || null) !== expectedWriteId) {
        tx.abort();
        await done.catch(() => {});
        throw new LocalStateChangedError();
      }
    }
    deleteRecords.forEach((record) => store.delete(this.scopedKey(record.entityKey)));
    const persisted = records.map((record) => {
      const replacement = {
        ...record,
        writeId: createWriteId(),
        key: this.scopedKey(record.entityKey),
        scope: this.driverId
      };
      store.put(replacement);
      return replacement;
    });
    if (records.length || deleteRecords.length) {
      await this.bumpOperationalRevision(tx.objectStore('metadata'));
    }
    await done;
    if (records.length || deleteRecords.length) this.broadcastChange('dirty');
    return persisted;
  }

  async deleteDirty(records) {
    await this.putDirtyMany([], records);
  }

  async listConflicts() {
    return this.listStore('conflicts');
  }

  async putConflicts(records) {
    const db = await this.dbPromise;
    const tx = db.transaction(['conflicts', 'metadata'], 'readwrite');
    const store = tx.objectStore('conflicts');
    const all = await requestResult(store.getAll());
    all.filter((record) => record.scope === this.driverId).forEach((record) => store.delete(record.key));
    records.forEach((record) => store.put({
      ...record,
      key: this.scopedKey(record.id),
      scope: this.driverId
    }));
    await this.bumpOperationalRevision(tx.objectStore('metadata'));
    await transactionDone(tx);
    this.broadcastChange('conflicts');
  }

  async acknowledgementIds() {
    return new Set((await this.listStore('acknowledgements')).map((record) => record.id));
  }

  async acknowledge(id) {
    const db = await this.dbPromise;
    const tx = db.transaction(['acknowledgements', 'metadata'], 'readwrite');
    tx.objectStore('acknowledgements').put({
      key: this.scopedKey(id),
      scope: this.driverId,
      id,
      acknowledgedAt: new Date().toISOString()
    });
    await this.bumpOperationalRevision(tx.objectStore('metadata'));
    await transactionDone(tx);
    this.broadcastChange('acknowledgements');
  }

  async clearAcknowledgement(id) {
    const db = await this.dbPromise;
    const tx = db.transaction(['acknowledgements', 'metadata'], 'readwrite');
    tx.objectStore('acknowledgements').delete(this.scopedKey(id));
    await this.bumpOperationalRevision(tx.objectStore('metadata'));
    await transactionDone(tx);
    this.broadcastChange('acknowledgements');
  }

  async operationalState() {
    const db = await this.dbPromise;
    const names = ['dirtyEntities', 'conflicts', 'acknowledgements', 'metadata'];
    const tx = db.transaction(names, 'readonly');
    const [dirty, conflicts, acknowledgements, revisionRecord] = await Promise.all([
      requestResult(tx.objectStore('dirtyEntities').getAll()),
      requestResult(tx.objectStore('conflicts').getAll()),
      requestResult(tx.objectStore('acknowledgements').getAll()),
      requestResult(tx.objectStore('metadata').get(this.scopedKey('operationalRevision')))
    ]);
    await transactionDone(tx);
    return {
      revision: Math.max(0, Number(revisionRecord?.value) || 0),
      dirty: dirty
        .filter((record) => record.scope === this.driverId)
        .sort((a, b) => a.sequence - b.sequence),
      conflicts: conflicts.filter((record) => record.scope === this.driverId),
      acknowledgements: new Set(
        acknowledgements.filter((record) => record.scope === this.driverId).map((record) => record.id)
      )
    };
  }

  async clearOperationalStateAndSave(document, expectedRevision) {
    const db = await this.dbPromise;
    const names = ['remoteSnapshot', 'dirtyEntities', 'conflicts', 'acknowledgements', 'metadata'];
    const tx = db.transaction(names, 'readwrite');
    const done = transactionDone(tx);
    const stores = names.map((name) => tx.objectStore(name));
    const snapshotStore = tx.objectStore('remoteSnapshot');
    const metadata = tx.objectStore('metadata');
    const revisionRecord = await requestResult(metadata.get(this.scopedKey('operationalRevision')));
    const currentRevision = Math.max(0, Number(revisionRecord?.value) || 0);
    if (currentRevision !== expectedRevision) {
      tx.abort();
      await done.catch(() => {});
      throw new LocalStateChangedError(
        'Local changes appeared in another tab during the restore. They were preserved; review them and retry.'
      );
    }
    const operationalStores = stores.slice(1, 4);
    const [snapshots, ...recordsByStore] = await Promise.all([
      requestResult(snapshotStore.getAll()),
      ...operationalStores.map((store) => requestResult(store.getAll()))
    ]);
    recordsByStore.forEach((records, index) => {
      records
        .filter((record) => record.scope === this.driverId)
        .forEach((record) => operationalStores[index].delete(record.key));
    });
    const savedAt = new Date().toISOString();
    const scopedSnapshots = snapshots
      .filter((entry) => entry.scope === this.driverId)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    scopedSnapshots.slice(4).forEach((entry) => snapshotStore.delete(entry.key));
    snapshotStore.put({
      key: this.scopedKey(
        `${String(document.version).padStart(12, '0')}|${savedAt}|${createWriteId()}`
      ),
      scope: this.driverId,
      savedAt,
      version: document.version,
      document
    });
    metadata.put({
      key: this.scopedKey('operationalRevision'),
      scope: this.driverId,
      name: 'operationalRevision',
      value: currentRevision + 1
    });
    await done;
    this.broadcastChange('restore');
  }
}
