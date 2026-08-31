import { DUPLICATE_TOLERANCE_MINUTES } from './utils.js';

function explicitBounds(session) {
  if (!session || session.timeKind !== 'explicit') return null;
  const start = Date.parse(session.start);
  const end = Date.parse(session.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

export function sessionsOverlap(left, right) {
  const a = explicitBounds(left);
  const b = explicitBounds(right);
  return !!a && !!b && a.start < b.end && b.start < a.end;
}

export function sessionsAreLikelyDuplicates(left, right, toleranceMinutes = DUPLICATE_TOLERANCE_MINUTES) {
  const a = explicitBounds(left);
  const b = explicitBounds(right);
  if (!a || !b || !sessionsOverlap(left, right)) return false;
  const tolerance = toleranceMinutes * 60000;
  return Math.abs(a.start - b.start) <= tolerance && Math.abs(a.end - b.end) <= tolerance;
}

function conflictId(type, members) {
  const value = JSON.stringify({
    type,
    members: [...members]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => ({
        id: session.id,
        start: session.start,
        end: session.end,
        dayMinutes: session.dayMinutes,
        nightMinutes: session.nightMinutes,
        note: session.note || '',
        source: session.source,
        timeKind: session.timeKind,
        revision: session.revision,
        updatedAt: session.updatedAt,
        updatedBy: session.updatedBy
      }))
  });
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `derived_${type}_${(hash >>> 0).toString(36)}`;
}

function notesSimilar(sessions) {
  const values = sessions
    .map((session) => String(session.note || '').trim().toLowerCase())
    .filter(Boolean);
  return values.length > 1 && new Set(values).size === 1;
}

export function detectSessionConflicts(sessions, { migratedAt = null, acknowledgements = new Set() } = {}) {
  const candidates = sessions.filter((session) => explicitBounds(session));
  const adjacency = new Map(candidates.map((session) => [session.id, new Set()]));
  const pairKinds = new Map();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i];
      const right = candidates[j];
      if (!sessionsOverlap(left, right)) continue;
      adjacency.get(left.id).add(right.id);
      adjacency.get(right.id).add(left.id);
      const key = [left.id, right.id].sort().join('|');
      pairKinds.set(key, sessionsAreLikelyDuplicates(left, right) ? 'duplicate' : 'overlap');
    }
  }

  const byId = new Map(candidates.map((session) => [session.id, session]));
  const seen = new Set();
  const groups = [];
  for (const session of candidates) {
    if (seen.has(session.id) || adjacency.get(session.id).size === 0) continue;
    const queue = [session.id];
    const ids = [];
    seen.add(session.id);
    while (queue.length) {
      const id = queue.shift();
      ids.push(id);
      for (const neighbor of adjacency.get(id)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const members = ids.map((id) => byId.get(id)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const allMigrated = !!migratedAt && members.every((member) =>
      Date.parse(member.createdAt) <= Date.parse(migratedAt)
    );
    const kinds = new Set();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const kind = pairKinds.get([ids[i], ids[j]].sort().join('|'));
        if (kind) kinds.add(kind);
      }
    }
    const type = kinds.size === 1 && kinds.has('duplicate') ? 'duplicate' : 'overlap';
    const id = conflictId(type, members);
    groups.push({
      id,
      type,
      memberIds: ids.sort(),
      members,
      confidenceHint: notesSimilar(members) ? 'matching notes' : '',
      acknowledged: allMigrated || acknowledgements.has(id),
      migrationBaseline: allMigrated
    });
  }
  return groups;
}

export function conflictEntityIds(conflicts) {
  const ids = new Set();
  for (const conflict of conflicts) {
    if (conflict.entityId) ids.add(conflict.entityId);
    for (const id of conflict.memberIds || []) ids.add(id);
  }
  return ids;
}
